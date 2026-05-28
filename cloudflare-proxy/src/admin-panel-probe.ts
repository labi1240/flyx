/**
 * DLHD Admin Panel Probe v2 — targets Flussonic + aaPanel from CF edge
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const results: Record<string, { status: number; len: number; preview: string }> = {};

    async function probeHttp(name: string, ip: string, port: number, path: string, hostHeader: string) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      try {
        const protocol = port === 443 ? 'https' : 'http';
        const url = `${protocol}://${ip}:${port}${path}`;
        const r = await fetch(url, {
          headers: {
            'Host': hostHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'text/html,application/json,*/*',
          },
          redirect: 'manual',
          signal: ac.signal,
        });
        clearTimeout(t);
        const text = await r.text();
        const title = (text.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
        const loc = r.headers.get('location') || '';
        const sigs: string[] = [];
        if (/aapanel/i.test(text)) sigs.push('AAPANEL');
        if (/login/i.test(text)) sigs.push('LOGIN');
        if (/password/i.test(text)) sigs.push('PASS');
        if (/flussonic/i.test(text)) sigs.push('FLUSSONIC');
        if (/stream/i.test(text)) sigs.push('STREAM');
        results[name] = {
          status: r.status,
          len: text.length,
          preview: `[${title.substring(0,60)}] ${sigs.join(',')} ${loc ? '→ '+loc : ''} | ${text.substring(0, 200).replace(/[\n\r\t]/g, ' ')}`,
        };
      } catch (e: any) {
        clearTimeout(t);
        results[name] = { status: 0, len: 0, preview: e.message.substring(0, 100) };
      }
    }

    const FLUSSONIC = '195.128.27.233';
    const STREAM = '213.21.239.30';

    // ================================================================
    // FLUSSONIC — probe from CF edge (may bypass firewall)
    // ================================================================
    const flussPorts = [8080, 80, 443, 8081, 8082, 888, 8443, 9090];
    const flussPaths = ['/', '/admin/', '/admin/login', '/flussonic/api/v3/', '/flussonic/api/v3/servers', '/flussonic/api/v3/streams', '/flussonic/', '/api/v3/'];
    const flussHosts = ['195.128.27.233', 'cdn-live-tv.ru', 'edge.cdn-live-tv.ru', 'cdn-live.tv'];

    const tasks: Promise<void>[] = [];

    for (const port of flussPorts) {
      for (const host of flussHosts) {
        tasks.push(probeHttp(`fluss_${port}_${host.replace(/[.\-]/g,'_')}_/`, FLUSSONIC, port, '/', host));
      }
    }

    // Also test deeper paths on port 8080 (most likely Flussonic port)
    for (const path of flussPaths) {
      for (const host of flussHosts.slice(0, 2)) {
        tasks.push(probeHttp(`fluss8080_${host.replace(/[.\-]/g,'_')}${path.replace(/[\/?=]/g,'_').substring(0,20)}`, FLUSSONIC, 8080, path, host));
      }
    }

    // ================================================================
    // STREAMING — try alternative Host headers we haven't tested
    // ================================================================
    // nginx default_server might respond to unknown hosts with the aaPanel login
    const altHosts = ['_', 'aapanel.local', 'panel.local', 'server.local', 'bt.local', 'chevy.local', 'admin.local'];
    for (const host of altHosts) {
      tasks.push(probeHttp(`alt_${host}`, STREAM, 80, '/', host));
      tasks.push(probeHttp(`alt_${host}_login`, STREAM, 80, '/login', host));
    }

    // Run in parallel batches
    const BATCH = 20;
    for (let i = 0; i < tasks.length; i += BATCH) {
      await Promise.all(tasks.slice(i, i + BATCH));
    }

    // Filter interesting results
    const interesting: Record<string, { status: number; len: number; preview: string }> = {};
    for (const [k, v] of Object.entries(results)) {
      if (v.status !== 0 && v.status !== 404) {
        interesting[k] = v;
      }
    }

    return new Response(JSON.stringify({ totalProbes: tasks.length, interesting: Object.keys(interesting).length, results: interesting }, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
