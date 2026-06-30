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

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        pacienteId: paciente.id,
        esGuayaquil
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
