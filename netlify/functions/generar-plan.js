const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { pacienteId, datos, imc } = JSON.parse(event.body);
    const d = datos;
    const esGuayaquil = d.ciudad.toLowerCase().includes('guaya');

    const prompt = `Eres NutriBot FMC, el asistente de nutricion clinica de Fundacion Medica CMS / NutriSLIM.
Genera un plan de alimentacion personalizado para este paciente.

DATOS DEL PACIENTE:
- Nombre: ${d.nombre}
- Edad: ${d.edad} anos | Sexo: ${d.sexo}
- Ciudad: ${d.ciudad}
- Peso: ${d.peso} kg | Talla: ${d.talla} cm | IMC: ${imc}
- Objetivos: ${(d.objetivos||[]).join(', ')}
- Meta: bajar ${d.metaKg || 'no especificado'} kg en ${d.plazo || 'no especificado'}
- Condiciones medicas: ${(d.condiciones||[]).join(', ') || 'Ninguna'}
- Medicamentos: ${d.medicamentos || 'Ninguno'}
- Alergias: ${d.alergias || 'Ninguna'}
- Actividad fisica: ${d.actividad || 'No especificado'}
- Comidas al dia: ${d.comidasDia || 'No especificado'}
- Tipo de alimentacion: ${d.tipoAlimentacion || 'Omnivoro'}
- Alimentos que NO consume: ${d.noGusta || 'Ninguno'}
- Cocina en casa: ${d.cocina || 'No especificado'}
- Presupuesto semanal: ${d.presupuesto || 'No especificado'}
- Alcohol: ${d.alcohol || 'No especificado'}

INSTRUCCIONES:
1. Calcula calorias con Harris-Benedict + factor actividad, aplica deficit de 500 kcal/dia.
2. Genera plan de 7 dias completos (Lunes a Domingo) con desayuno, merienda manana, almuerzo, merienda tarde y cena.
3. Usa alimentos ecuatorianos: arroz, verde, yuca, menestra, pollo, pescado, frutas tropicales.
4. NO uses alimentos de la lista de no-gusta ni alergias.
5. Si hay condicion medica (diabetes, hipertension, hipotiroidismo), aplica restricciones clinicas.
6. Genera 3 metas semanales medibles.
7. Genera 1 desafio gamificado con puntos.
8. Si ciudad es Guayaquil, incluye derivacion a Fundacion Medica CMS.
9. Cierra con mensaje motivacional personalizado.

RESPONDE SOLO CON JSON PURO. Sin markdown, sin explicaciones, sin bloques de codigo.
{
  "perfil_calculado": {"calorias_objetivo": 0, "proteina_g": 0, "grasa_g": 0, "carbohidratos_g": 0},
  "plan_dias": [
    {"dia": "Lunes", "total_calorias": 0, "comidas": {
      "desayuno": {"descripcion": "", "calorias": 0},
      "merienda_manana": {"descripcion": "", "calorias": 0},
      "almuerzo": {"descripcion": "", "calorias": 0},
      "merienda_tarde": {"descripcion": "", "calorias": 0},
      "cena": {"descripcion": "", "calorias": 0}
    }}
  ],
  "metas_semana": [
    {"tipo": "alimentacion", "meta": "", "como_medirla": ""},
    {"tipo": "hidratacion", "meta": "", "como_medirla": ""},
    {"tipo": "movimiento", "meta": "", "como_medirla": ""}
  ],
  "desafio_semana": {"nombre": "", "descripcion": "", "duracion_dias": 7, "puntos": 0, "recompensa": ""},
  "nota_clinica": "",
  "derivacion_cms": {"aplica": false, "mensaje": "", "examenes_recomendados": []},
  "alerta_medica": "",
  "mensaje_motivacional": ""
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    let planData;
    try {
      const rawText = response.content[0].text;
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      planData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Error parsing plan JSON:', parseErr);
      throw new Error('Error generando el plan');
    }

    const { data: plan, error: planError } = await supabase
      .from('planes')
      .insert([{
        paciente_id: pacienteId,
        semana: 1,
        calorias_objetivo: planData.perfil_calculado?.calorias_objetivo,
        proteina_g: planData.perfil_calculado?.proteina_g,
        grasa_g: planData.perfil_calculado?.grasa_g,
        carbohidratos_g: planData.perfil_calculado?.carbohidratos_g,
        plan_7_dias: planData.plan_dias,
        metas_semana: planData.metas_semana,
        desafio_semana: planData.desafio_semana,
        nota_clinica: planData.nota_clinica,
        derivacion_cms: planData.derivacion_cms,
        alerta_medica: planData.alerta_medica,
        mensaje_motivacional: planData.mensaje_motivacional
      }])
      .select()
      .single();

    if (planError) throw planError;

    await enviarEmailBienvenida(d, planData, esGuayaquil);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, planId: plan.id })
    };

  } catch (err) {
    console.error('Error en generar-plan:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function enviarEmailBienvenida(datos, plan, esGuayaquil) {
  const dia1 = plan.plan_dias && plan.plan_dias[0];
  const meta1 = plan.metas_semana && plan.metas_semana[0];
  const desafio = plan.desafio_semana;
  const calorias = plan.perfil_calculado ? plan.perfil_calculado.calorias_objetivo : null;
  const proteina = plan.perfil_calculado ? plan.perfil_calculado.proteina_g : null;

  let comidasHtml = '';
  if (dia1 && dia1.comidas) {
    const tipos = {
      desayuno: 'Desayuno',
      merienda_manana: 'Merienda manana',
      almuerzo: 'Almuerzo',
      merienda_tarde: 'Merienda tarde',
      cena: 'Cena'
    };
    for (const key in dia1.comidas) {
      const comida = dia1.comidas[key];
      const nombre = tipos[key] || key;
      comidasHtml += '<div class="meal"><span>' + nombre + ': ' + comida.descripcion + '</span><span class="meal-cal">' + comida.calorias + ' kcal</span></div>';
    }
  }

  const cmsBoxHtml = esGuayaquil
    ? '<div class="cms-box"><strong>Eres de Guayaquil</strong><p style="margin:6px 0 0;font-size:13px">Para tus examenes de laboratorio y control medico presencial, acude a Fundacion Medica CMS. Tu orden medica digital ya esta lista para descargar desde tu perfil.</p></div>'
    : '';

  const motivacionalHtml = plan.mensaje_motivacional
    ? '<p style="background:#F2FAF6;border-radius:10px;padding:14px;font-style:italic">' + plan.mensaje_motivacional + '</p>'
    : '';

  const alertaHtml = plan.alerta_medica
    ? '<p style="background:#FEE2E2;border-radius:10px;padding:12px;color:#DC2626;font-size:13px">Atencion: ' + plan.alerta_medica + '</p>'
    : '';

  const challengeHtml = desafio
    ? '<div class="challenge"><div class="challenge-title">Desafio: ' + desafio.nombre + '</div><p style="margin:0;font-size:13px">' + desafio.descripcion + ' - Gana ' + desafio.puntos + ' puntos si lo completas.</p></div>'
    : '';

  const metaHtml = meta1
    ? '<p><strong>Tu meta numero 1 esta semana:</strong> ' + meta1.meta + '<br><small>' + meta1.como_medirla + '</small></p>'
    : '';

  const htmlEmail = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:Arial,sans-serif;background:#F7F9F7;margin:0;padding:0}' +
    '.container{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden}' +
    '.header{background:#1A7A52;padding:32px 28px;text-align:center}' +
    '.logo{color:#fff;font-size:26px;font-weight:800;letter-spacing:-1px}' +
    '.body{padding:28px}' +
    'h2{color:#0F1A14;font-size:20px;margin-bottom:8px}' +
    'p{color:#3D5446;font-size:14px;line-height:1.6;margin-bottom:14px}' +
    '.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0}' +
    '.stat{background:#F2FAF6;border-radius:10px;padding:14px;text-align:center}' +
    '.stat-val{font-size:22px;font-weight:800;color:#1A7A52}' +
    '.stat-label{font-size:11px;color:#7A9487;margin-top:3px}' +
    '.day-card{background:#F7F9F7;border-radius:10px;padding:16px;margin:16px 0}' +
    '.day-title{font-weight:700;color:#1A7A52;margin-bottom:10px;font-size:15px}' +
    '.meal{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #D6E8DE;font-size:13px;color:#3D5446}' +
    '.meal-cal{font-weight:600;color:#1A7A52}' +
    '.challenge{background:#E6F5EE;border:1px solid #25A96E;border-radius:10px;padding:16px;margin:16px 0}' +
    '.challenge-title{font-weight:700;color:#1A7A52;margin-bottom:6px}' +
    '.cms-box{background:#FEF3E2;border:1px solid #F5C842;border-radius:10px;padding:16px;margin:16px 0}' +
    '.footer{background:#F7F9F7;padding:20px 28px;text-align:center;font-size:12px;color:#7A9487}' +
    '.btn{display:inline-block;background:#1A7A52;color:#fff;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:600;font-size:14px;margin:16px 0}' +
    '</style></head><body><div class="container">' +
    '<div class="header"><div class="logo">NutriSLIM</div><p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px">Tu plan personalizado esta listo</p></div>' +
    '<div class="body">' +
    '<h2>Hola, ' + datos.nombre.split(' ')[0] + '!</h2>' +
    '<p>Tu plan de nutricion personalizado generado por inteligencia artificial y supervisado por medicos de Fundacion Medica CMS esta listo. Aqui tienes un resumen:</p>' +
    '<div class="stat-grid">' +
    '<div class="stat"><div class="stat-val">' + (calorias || '-') + '</div><div class="stat-label">kcal / dia</div></div>' +
    '<div class="stat"><div class="stat-val">' + (proteina || '-') + 'g</div><div class="stat-label">proteina</div></div>' +
    '<div class="stat"><div class="stat-val">7</div><div class="stat-label">dias de plan</div></div>' +
    '</div>' +
    (dia1 ? '<div class="day-card"><div class="day-title">Tu menu del ' + dia1.dia + ' (' + dia1.total_calorias + ' kcal)</div>' + comidasHtml + '</div>' : '') +
    metaHtml +
    challengeHtml +
    cmsBoxHtml +
    motivacionalHtml +
    '<p style="text-align:center"><a href="https://nutrislimed.netlify.app/onboarding" class="btn">Ver mi plan completo</a></p>' +
    alertaHtml +
    '</div>' +
    '<div class="footer">NutriSLIM - Fundacion Medica CMS - Guayaquil, Ecuador<br>Tu plan dura 30 dias. Recibiras un recordatorio 8 dias antes de que venza.</div>' +
    '</div></body></html>';

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'NutriSLIM', email: process.env.BREVO_FROM_EMAIL },
      to: [{ email: datos.email, name: datos.nombre }],
      subject: 'Tu plan NutriSLIM esta listo, ' + datos.nombre.split(' ')[0],
      htmlContent: htmlEmail
    })
  });
}
