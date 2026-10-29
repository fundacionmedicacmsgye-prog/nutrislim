const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DIAS_ES = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { pacienteId, enviarEmail } = JSON.parse(event.body);

    if (!pacienteId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'pacienteId requerido' }) };
    }

    // Leer datos del paciente desde Supabase
    const { data: paciente, error: pacienteError } = await supabase
      .from('pacientes')
      .select('*')
      .eq('id', pacienteId)
      .single();

    if (pacienteError || !paciente) {
      throw new Error('Paciente no encontrado: ' + (pacienteError?.message || 'sin datos'));
    }

    const d = paciente;
    const esGuayaquil = (d.ciudad || '').toLowerCase().includes('guaya');

    const hoy = new Date();
    const diaSemana = DIAS_ES[hoy.getDay()];
    const fechaISO = hoy.toISOString().split('T')[0]; // YYYY-MM-DD

    const imc = d.imc || (d.peso && d.talla
      ? parseFloat((d.peso / ((d.talla / 100) ** 2)).toFixed(1))
      : null);

    const prompt = `Eres NutriBot FMC, el asistente de nutricion clinica de Fundacion Medica CMS / NutriSLIM.
Genera el menu de alimentacion de HOY (${diaSemana}) para este paciente.

DATOS DEL PACIENTE:
- Nombre: ${d.nombre}
- Edad: ${d.edad} anos | Sexo: ${d.sexo}
- Ciudad: ${d.ciudad}
- Peso: ${d.peso} kg | Talla: ${d.talla} cm | IMC: ${imc || 'no calculado'}
- Objetivos: ${(d.objetivos || []).join(', ') || 'Bajar de peso'}
- Meta: bajar ${d.meta_kg || 'no especificado'} kg en ${d.plazo || 'no especificado'}
- Condiciones medicas: ${(d.condiciones || []).join(', ') || 'Ninguna'}
- Medicamentos: ${d.medicamentos || 'Ninguno'}
- Alergias: ${d.alergias || 'Ninguna'}
- Actividad fisica: ${d.actividad || 'No especificado'}
- Comidas al dia: ${d.comidas_dia || 3}
- Tipo de alimentacion: ${d.tipo_alimentacion || 'Omnivoro'}
- Alimentos que NO consume: ${d.no_gusta || 'Ninguno'}
- Cocina en casa: ${d.cocina || 'Si'}
- Presupuesto semanal: ${d.presupuesto || 'No especificado'}

INSTRUCCIONES:
1. Calcula calorias con Harris-Benedict + factor actividad, aplica deficit de 500 kcal/dia.
2. Genera el menu SOLO de hoy (${diaSemana}) con desayuno, merienda manana, almuerzo, merienda tarde y cena.
3. Usa alimentos ecuatorianos: arroz, verde, yuca, menestra, pollo, pescado, frutas tropicales.
4. NO uses alimentos de la lista no-gusta ni alergias.
5. Si hay condicion medica (diabetes, hipertension, hipotiroidismo), aplica restricciones clinicas.
6. Incluye 1 meta del dia y 1 tip practico.
7. Si ciudad es Guayaquil, incluye derivacion a Fundacion Medica CMS.
8. Mensaje motivacional breve personalizado.

RESPONDE SOLO CON JSON PURO. Sin markdown, sin explicaciones, sin bloques de codigo.
{
  "calorias_objetivo": 0,
  "proteina_g": 0,
  "grasa_g": 0,
  "carbohidratos_g": 0,
  "comidas": {
    "desayuno": {"descripcion": "", "calorias": 0},
    "merienda_manana": {"descripcion": "", "calorias": 0},
    "almuerzo": {"descripcion": "", "calorias": 0},
    "merienda_tarde": {"descripcion": "", "calorias": 0},
    "cena": {"descripcion": "", "calorias": 0}
  },
  "meta_dia": "",
  "tip_dia": "",
  "nota_clinica": "",
  "derivacion_cms": {"aplica": false, "mensaje": "", "examenes_recomendados": []},
  "alerta_medica": "",
  "mensaje_motivacional": ""
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }]
    });

    let planData;
    try {
      const rawText = response.content[0].text;
      // Extrae el JSON entre el primer { y el último }
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON found in response');
      const jsonStr = rawText.substring(start, end + 1);
      planData = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('Error parsing plan JSON:', parseErr.message);
      console.error('Raw response:', response.content[0]?.text?.substring(0, 500));
      throw new Error('Error generando el plan: ' + parseErr.message);
    }

    // Guardar en planes_diarios (upsert por paciente+fecha)
    const { data: planGuardado, error: planError } = await supabase
      .from('planes_diarios')
      .upsert([{
        paciente_id: pacienteId,
        fecha: fechaISO,
        dia_semana: diaSemana,
        calorias_objetivo: planData.calorias_objetivo,
        proteina_g: planData.proteina_g,
        grasa_g: planData.grasa_g,
        carbohidratos_g: planData.carbohidratos_g,
        comidas: planData.comidas,
        meta_dia: planData.meta_dia,
        tip_dia: planData.tip_dia,
        nota_clinica: planData.nota_clinica,
        derivacion_cms: planData.derivacion_cms,
        alerta_medica: planData.alerta_medica,
        mensaje_motivacional: planData.mensaje_motivacional
      }], { onConflict: 'paciente_id,fecha' })
      .select()
      .single();

    if (planError) throw planError;

    // Enviar email solo si se pide (primer registro)
    if (enviarEmail === true) {
      await enviarEmailBienvenida(d, planData, diaSemana, esGuayaquil);
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        planId: planGuardado.id,
        fecha: fechaISO,
        dia: diaSemana,
        plan: planData
      })
    };

  } catch (err) {
    console.error('Error en generar-plan:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

async function enviarEmailBienvenida(datos, plan, diaSemana, esGuayaquil) {
  const comidas = plan.comidas || {};
  const calorias = plan.calorias_objetivo;
  const proteina = plan.proteina_g;

  const tiposComida = {
    desayuno: 'Desayuno',
    merienda_manana: 'Merienda manana',
    almuerzo: 'Almuerzo',
    merienda_tarde: 'Merienda tarde',
    cena: 'Cena'
  };

  let comidasHtml = '';
  for (const key in comidas) {
    const comida = comidas[key];
    const nombre = tiposComida[key] || key;
    comidasHtml += '<div class="meal"><span>' + nombre + ': ' + comida.descripcion + '</span><span class="meal-cal">' + comida.calorias + ' kcal</span></div>';
  }

  const cmsBoxHtml = esGuayaquil
    ? '<div class="cms-box"><strong>Eres de Guayaquil</strong><p style="margin:6px 0 0;font-size:13px">Para tus examenes y control medico presencial, acude a Fundacion Medica CMS. Tu orden medica digital esta lista en tu perfil.</p></div>'
    : '';

  const motivacionalHtml = plan.mensaje_motivacional
    ? '<p style="background:#F2FAF6;border-radius:10px;padding:14px;font-style:italic">' + plan.mensaje_motivacional + '</p>'
    : '';

  const alertaHtml = plan.alerta_medica
    ? '<p style="background:#FEE2E2;border-radius:10px;padding:12px;color:#DC2626;font-size:13px">Atencion: ' + plan.alerta_medica + '</p>'
    : '';

  const metaHtml = plan.meta_dia
    ? '<p><strong>Tu meta de hoy:</strong> ' + plan.meta_dia + '</p>'
    : '';

  const tipHtml = plan.tip_dia
    ? '<p><strong>Tip del dia:</strong> ' + plan.tip_dia + '</p>'
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
    '.cms-box{background:#FEF3E2;border:1px solid #F5C842;border-radius:10px;padding:16px;margin:16px 0}' +
    '.footer{background:#F7F9F7;padding:20px 28px;text-align:center;font-size:12px;color:#7A9487}' +
    '.btn{display:inline-block;background:#1A7A52;color:#fff;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:600;font-size:14px;margin:16px 0}' +
    '</style></head><body><div class="container">' +
    '<div class="header"><div class="logo">NutriSLIM</div><p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px">Tu menu de hoy esta listo</p></div>' +
    '<div class="body">' +
    '<h2>Hola, ' + datos.nombre.split(' ')[0] + '! Tu plan NutriSLIM esta activo.</h2>' +
    '<p>Tu menu personalizado para hoy (<strong>' + diaSemana + '</strong>), generado por inteligencia artificial y supervisado por medicos de Fundacion Medica CMS:</p>' +
    '<div class="stat-grid">' +
    '<div class="stat"><div class="stat-val">' + (calorias || '-') + '</div><div class="stat-label">kcal hoy</div></div>' +
    '<div class="stat"><div class="stat-val">' + (proteina || '-') + 'g</div><div class="stat-label">proteina</div></div>' +
    '<div class="stat"><div class="stat-val">5</div><div class="stat-label">comidas</div></div>' +
    '</div>' +
    '<div class="day-card"><div class="day-title">Menu del ' + diaSemana + '</div>' + comidasHtml + '</div>' +
    metaHtml +
    tipHtml +
    cmsBoxHtml +
    motivacionalHtml +
    '<p style="text-align:center"><a href="https://nutrislimed.netlify.app/portal" class="btn">Ver mi portal NutriSLIM</a></p>' +
    alertaHtml +
    '</div>' +
    '<div class="footer">NutriSLIM - Fundacion Medica CMS - Guayaquil, Ecuador<br>Genera tu menu diario desde tu portal cada dia.</div>' +
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
      subject: 'Tu menu NutriSLIM para hoy (' + diaSemana + '), ' + datos.nombre.split(' ')[0],
      htmlContent: htmlEmail
    })
  });
}
