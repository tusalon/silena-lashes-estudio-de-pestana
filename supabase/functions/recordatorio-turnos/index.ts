// recordatorio-turnos — envía por ntfy los turnos de HOY al admin
// Corre a las 8 AM y 9 AM hora Cuba via Supabase pg_cron (no depende de PC ni GitHub)
// push_recordatorio_enviado evita duplicados si corre varias veces

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fechaHoy(): string {
  // Hora Cuba (UTC-4)
  const now = new Date();
  now.setHours(now.getHours() - 4);
  return now.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl  = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Variables de entorno no configuradas" }, 503);
  }

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const body = await req.json().catch(() => ({}));
  const negocioFiltro = body?.negocio_id || null;
  const hoy = fechaHoy();

  // Buscar turnos de HOY que aún NO fueron notificados
  let url = `${supabaseUrl}/rest/v1/reservas?fecha=eq.${hoy}&estado=neq.Cancelado&push_recordatorio_enviado=eq.false&select=id,negocio_id,cliente_nombre,cliente_whatsapp,servicio,hora_inicio`;
  if (negocioFiltro) url += `&negocio_id=eq.${negocioFiltro}`;

  const resReservas = await fetch(url, { headers });
  if (!resReservas.ok) return jsonResponse({ error: "Error consultando reservas" }, 500);
  const reservas = await resReservas.json();

  if (!reservas.length) {
    return jsonResponse({ ok: true, fecha: hoy, enviados: 0, mensaje: "Sin turnos pendientes de notificar" });
  }

  // Agrupar por negocio
  const porNegocio: Record<string, typeof reservas> = {};
  for (const r of reservas) {
    if (!porNegocio[r.negocio_id]) porNegocio[r.negocio_id] = [];
    porNegocio[r.negocio_id].push(r);
  }

  let enviados = 0;
  const notificadosIds: number[] = [];
  const errores: string[] = [];

  for (const [negocioId, turnos] of Object.entries(porNegocio)) {
    // Obtener ntfy_topic del negocio
    const negocioRes = await fetch(
      `${supabaseUrl}/rest/v1/negocios?id=eq.${negocioId}&select=nombre,ntfy_topic`,
      { headers }
    );
    const negocios = negocioRes.ok ? await negocioRes.json() : [];
    const negocio = negocios[0];
    const ntfyTopic = negocio?.ntfy_topic;

    if (!ntfyTopic) { errores.push(`Sin ntfy_topic negocio ${negocioId}`); continue; }

    // Construir mensaje
    const lineas = turnos
      .sort((a: any, b: any) => a.hora_inicio.localeCompare(b.hora_inicio))
      .map((r: any) => {
        const [h, m] = r.hora_inicio.split(":").map(Number);
        const hora12 = `${h > 12 ? h - 12 : h || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
        return `${hora12} — ${r.cliente_nombre}`;
      });

    const titulo = `Hoy tienes ${turnos.length} turno${turnos.length > 1 ? "s" : ""}`;
    const cuerpo = lineas.join("\n");

    // Enviar por ntfy
    try {
      const ntfyRes = await fetch(`https://ntfy.sh/${ntfyTopic}`, {
        method: "POST",
        headers: {
          "Title": titulo,
          "Priority": "high",
          "Tags": "calendar,spiral_calendar",
          "Content-Type": "text/plain",
        },
        body: cuerpo,
      });

      if (ntfyRes.ok) {
        enviados++;
        notificadosIds.push(...turnos.map((r: any) => r.id));
      } else {
        errores.push(`ntfy error ${ntfyTopic}: ${ntfyRes.status}`);
      }
    } catch (err: any) {
      errores.push(`ntfy fallo ${ntfyTopic}: ${err?.message}`);
    }
  }

  // Marcar reservas como notificadas para evitar duplicados
  if (notificadosIds.length > 0) {
    await fetch(`${supabaseUrl}/rest/v1/reservas?id=in.(${notificadosIds.join(",")})`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ push_recordatorio_enviado: true }),
    });
  }

  return jsonResponse({
    ok: true,
    fecha: hoy,
    total_reservas: reservas.length,
    enviados,
    notificados: notificadosIds,
    errores: errores.length ? errores : undefined,
  });
});
