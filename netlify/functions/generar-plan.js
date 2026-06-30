const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { pacienteId, datos, imc, numeroDia, passwordTemporal } = JSON.parse(event.body);
    const d = datos;
    const esGuayaquil = d.ciudad.toLowerCase().includes('guaya');
    const diaActual = numeroDia || 1;
    const nombresDias = ['Lunes','Martes','Miercoles','Jueves','Viernes','Sabado','Domingo'];
    const nombreDiaActual = nombresDias[(diaActual - 1) % 7];

    const prompt = `Eres NutriBot FMC de NutriSLIM / Fundacion Medica CMS. Genera el plan de UN SOLO DIA (` + nombreDiaActual + `) para este paciente. RESPONDE RAPIDO, SE BREVE.

PACIENTE: ${d.nombre}, ${d.edad} anos, ${d.sexo}, ${d.ciudad}. Peso ${d.peso}kg, talla ${d.talla}cm, IMC ${imc}.
Objetivo: ${(d.objetivos||[]).join(', ')}. Condiciones: ${(d.condiciones||[]).join(', ') || 'Ninguna'}.
Alergias/no come: ${d.alergias || 'Ninguna'} / ${d.noGusta || 'Ninguno'}.
Actividad: ${d.actividad || 'No especificado'}. Tipo dieta: ${d.tipoAlimentacion || 'Omnivoro'}.

INSTRUCCIONES OBLIGATORIAS:
1. Calcula calorias objetivo con Harris-Benedict + actividad, deficit 500kcal.
2. DEBES incluir LAS 3 comidas, sin excepcion: desayuno, almuerzo Y cena. NUNCA omitas ninguna. Alimentos ecuatorianos (arroz, verde, pollo, pescado, menestra). Descripcion de 5 a 8 palabras cada una.
3. Respeta alergias y condiciones medicas.
4. 1 meta corta para hoy (maximo 10 palabras).
5. Si es Guayaquil, 1 frase breve de derivacion a CMS.
6. Mensaje motivacional de 1 frase corta.
IMPORTANTE: las 3 comidas (desayuno, almuerzo, cena) son obligatorias en el JSON. No las omitas por brevedad.

JSON COMPACTO SIN SALTOS DE LINEA:
{"dia":"` + nombreDiaActual + `","numero_dia":${diaActual},"calorias_objetivo":0,"proteina_g":0,"comidas":{"desayuno":{"descripcion":"","calorias":0},"almuerzo":{"descripcion":"","calorias":0},"cena":{"descripcion":"","calorias":0}},"meta_hoy":"","derivacion_cms":{"aplica":false,"mensaje":""},"alerta_medica":"","mensaje_motivacional":""}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
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
        calorias_objetivo: planData.calorias_objetivo,
        proteina_g: planData.proteina_g,
        plan_7_dias: [planData],
        nota_clinica: planData.alerta_medica || '',
        derivacion_cms: planData.derivacion_cms,
        alerta_medica: planData.alerta_medica,
        mensaje_motivacional: planData.mensaje_motivacional
      }])
      .select()
      .single();

    if (planError) throw planError;

    await enviarEmailBienvenida(d, planData, esGuayaquil, passwordTemporal);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, planId: plan.id })
    };

  } catch (err) {
    console.error('Error en generar-plan:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function enviarEmailBienvenida(datos, plan, esGuayaquil, passwordTemporal) {
  const comidas = plan.comidas || {};
  let comidasHtml = '';
  const tipos = { desayuno: 'Desayuno', almuerzo: 'Almuerzo', cena: 'Cena' };
  for (const key in comidas) {
    const c = comidas[key];
    const nombre = tipos[key] || key;
    comidasHtml += '<div class="meal"><span>' + nombre + ': ' + c.descripcion + '</span><span class="meal-cal">' + c.calorias + ' kcal</span></div>';
  }

  const cmsBoxHtml = (esGuayaquil && plan.derivacion_cms && plan.derivacion_cms.mensaje)
    ? '<div class="cms-box"><strong>Eres de Guayaquil</strong><p style="margin:6px 0 0;font-size:13px">' + plan.derivacion_cms.mensaje + '</p></div>'
    : '';

  const motivacionalHtml = plan.mensaje_motivacional
    ? '<p style="background:#F2FAF6;border-radius:10px;padding:14px;font-style:italic">' + plan.mensaje_motivacional + '</p>'
    : '';

  const alertaHtml = plan.alerta_medica
    ? '<p style="background:#FEE2E2;border-radius:10px;padding:12px;color:#DC2626;font-size:13px">Atencion: ' + plan.alerta_medica + '</p>'
    : '';

  const metaHtml = plan.meta_hoy
    ? '<p><strong>Tu meta de hoy:</strong> ' + plan.meta_hoy + '</p>'
    : '';

  const htmlEmail = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:Arial,sans-serif;background:#F7F9F7;margin:0;padding:0}' +
    '.container{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden}' +
    '.header{background:#1A7A52;padding:32px 28px;text-align:center}' +
    '.logo{color:#fff;font-size:26px;font-weight:800;letter-spacing:-1px}' +
    '.body{padding:28px}' +
    'h2{color:#0F1A14;font-size:20px;margin-bottom:8px}' +
    'p{color:#3D5446;font-size:14px;line-height:1.6;margin-bottom:14px}' +
    '.stat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:20px 0}' +
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
    '<h2>Hola, ' + datos.nombre.split(' ')[0] + '!</h2>' +
    '<p>Aqui esta tu menu personalizado de ' + plan.dia + ', generado por IA y supervisado por Fundacion Medica CMS:</p>' +
    (passwordTemporal ? '<div style="background:#E6F1FB;border:1px solid #85B7EB;border-radius:10px;padding:16px;margin-bottom:16px"><strong style="color:#0C447C;display:block;margin-bottom:8px">Tu acceso a NutriSLIM</strong><p style="margin:0;font-size:13px;color:#0C447C">Correo: ' + datos.email + '<br>Contrasena temporal: <strong>' + passwordTemporal + '</strong></p><p style="margin:8px 0 0;font-size:12px;color:#185FA5">Ingresa a nutrislimed.netlify.app/portal y cambia tu contrasena en tu perfil.</p></div>' : '') +
    '<div class="stat-grid">' +
    '<div class="stat"><div class="stat-val">' + (plan.calorias_objetivo || '-') + '</div><div class="stat-label">kcal hoy</div></div>' +
    '<div class="stat"><div class="stat-val">' + (plan.proteina_g || '-') + 'g</div><div class="stat-label">proteina</div></div>' +
    '</div>' +
    '<div class="day-card"><div class="day-title">Menu de ' + plan.dia + '</div>' + comidasHtml + '</div>' +
    metaHtml +
    cmsBoxHtml +
    motivacionalHtml +
    '<p style="text-align:center"><a href="https://nutrislimed.netlify.app/portal" class="btn">Ver mi plan completo</a></p>' +
    alertaHtml +
    '</div>' +
    '<div class="footer">NutriSLIM - Fundacion Medica CMS - Guayaquil, Ecuador<br>Vuelve manana para tu siguiente menu personalizado.</div>' +
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
      subject: 'Tu menu de ' + plan.dia + ' esta listo, ' + datos.nombre.split(' ')[0],
      htmlContent: htmlEmail
    })
  });
}