const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
    const data = JSON.parse(event.body);

    function generarPassword() {
      const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
      let pass = '';
      for (let i = 0; i < 8; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
      return pass;
    }
    const passwordGenerada = generarPassword();

    let authUserId;
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email: data.email,
      password: passwordGenerada,
      email_confirm: true
    });

    if (authError) {
      if (authError.message && authError.message.includes('already been registered')) {
        const { data: listaUsuarios } = await supabase.auth.admin.listUsers();
        const usuarioExistente = listaUsuarios.users.find(u => u.email === data.email);
        if (usuarioExistente) {
          authUserId = usuarioExistente.id;
          await supabase.auth.admin.updateUserById(usuarioExistente.id, { password: passwordGenerada });
        } else {
          throw new Error('No se pudo crear ni encontrar la cuenta del paciente');
        }
      } else {
        console.error('Error creando usuario auth:', authError);
        throw new Error('No se pudo crear la cuenta: ' + authError.message);
      }
    } else {
      authUserId = authUser.user.id;
    }
    const esGuayaquil = data.ciudad.toLowerCase().includes('guaya');

    const imc = data.peso && data.talla
      ? parseFloat((data.peso / ((data.talla / 100) ** 2)).toFixed(1))
      : null;

    const planVence = data.planElegido !== 'free'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const teleconsultasIniciales = data.planElegido === '49' ? 2 : data.planElegido === '19' ? 1 : 0;

    const { data: paciente, error } = await supabase
      .from('pacientes')
      .insert([{
        nombre: data.nombre,
        email: data.email,
        telefono: data.telefono,
        ciudad: data.ciudad,
        es_guayaquil: esGuayaquil,
        edad: parseInt(data.edad),
        sexo: data.sexo,
        peso: parseFloat(data.peso),
        talla: parseInt(data.talla),
        imc: imc,
        cintura: data.cintura ? parseInt(data.cintura) : null,
        cadera: data.cadera ? parseInt(data.cadera) : null,
        objetivos: data.objetivos || [],
        meta_kg: data.metaKg ? parseInt(data.metaKg) : null,
        plazo: data.plazo,
        condiciones: data.condiciones || [],
        medicamentos: data.medicamentos,
        alergias: data.alergias,
        actividad: data.actividad,
        comidas_dia: data.comidasDia,
        alcohol: data.alcohol,
        sueno: data.sueno,
        tipo_alimentacion: data.tipoAlimentacion,
        no_gusta: data.noGusta,
        cocina: data.cocina,
        presupuesto: data.presupuesto,
        plan_elegido: data.planElegido || 'free',
        plan_activo: false,
        plan_vence_en: planVence,
        teleconsultas_disponibles: teleconsultasIniciales,
        teleconsultas_usadas: 0,
        auth_user_id: authUserId,
        consentimiento_aceptado: true,
        consentimiento_fecha: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    await supabase.from('consentimientos').insert([{
      paciente_id: paciente.id,
      ip_address: event.headers['x-forwarded-for'] || 'unknown',
      user_agent: event.headers['user-agent'] || 'unknown'
    }]);

    // Notificar al administrador de NutriSLIM del nuevo registro
    const nombresPlan = { free: 'Gratuito', '19': 'Transformación $19', '49': 'VIP Clínico $49' };
    const planNombre = nombresPlan[data.planElegido] || 'Gratuito';
    const emailAdmin = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
<div style="background:#1A7A52;padding:20px;text-align:center">
<h2 style="color:#fff;margin:0">NutriSLIM — Nuevo paciente registrado</h2>
</div>
<div style="padding:24px">
<p style="font-size:15px;color:#333;margin-bottom:16px">Se acaba de registrar un nuevo paciente en la plataforma:</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
<tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666;width:140px">Nombre</td><td style="padding:10px;font-weight:500">${data.nombre}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">Email</td><td style="padding:10px">${data.email}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">WhatsApp</td><td style="padding:10px">${data.telefono}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">Ciudad</td><td style="padding:10px">${data.ciudad}${esGuayaquil ? ' 🏥 (Guayaquil - CMS)' : ''}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">Plan elegido</td><td style="padding:10px;font-weight:500;color:#1A7A52">${planNombre}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">Condiciones</td><td style="padding:10px">${(data.condiciones || []).join(', ') || 'Ninguna'}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">Objetivo</td><td style="padding:10px">${(data.objetivos || []).join(', ') || 'No especificado'}</td></tr>
<tr><td style="padding:10px;color:#666">IMC</td><td style="padding:10px">${imc || 'No calculado'}</td></tr>
</table>
${data.planElegido !== 'free' ? `<div style="background:#FEF3E2;border-radius:8px;padding:14px;margin-top:16px;font-size:13px;color:#633806">⚠️ Este paciente eligió el plan <strong>${planNombre}</strong>. Verifica el pago en PayPhone y activa su plan en Supabase.</div>` : ''}
<div style="margin-top:20px;text-align:center">
<a href="https://supabase.com/dashboard/project/shgwgpvhkperagkzlzuy/editor" style="background:#1A7A52;color:#fff;padding:10px 20px;border-radius:50px;text-decoration:none;font-size:13px;font-weight:500">Ver en Supabase →</a>
</div>
</div>
<div style="background:#f5f5f5;padding:14px;text-align:center;font-size:12px;color:#999">NutriSLIM · Fundación Médica CMS · Sistema de notificaciones automáticas</div>
</div>
</body></html>`;

    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: 'NutriSLIM Sistema', email: process.env.BREVO_FROM_EMAIL },
          to: [{ email: 'fundacionmedicacmsgye@gmail.com', name: 'Admin NutriSLIM' }],
          subject: '🆕 Nuevo paciente: ' + data.nombre + ' — Plan ' + planNombre,
          htmlContent: emailAdmin
        })
      });
    } catch (emailErr) {
      console.error('Error enviando notificacion admin:', emailErr);
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        pacienteId: paciente.id,
        esGuayaquil,
        passwordTemporal: passwordGenerada
      })
    };

  } catch (err) {
    console.error('Error en registrar-paciente:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
