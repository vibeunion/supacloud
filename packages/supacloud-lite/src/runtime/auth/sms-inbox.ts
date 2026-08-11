import type { SmsMessage, SmsSender } from '../types.js'

/** A captured local-dev SMS. This data is never mounted on a network-exposed backend. */
export interface SmsInboxEntry extends SmsMessage {
  id: string
  created_at: string
  code: string | null
}

const CAP = 200

/** Bounded, in-memory SMS sink used only on loopback for local phone-auth testing. */
export class SmsInbox implements SmsSender {
  private messages: SmsInboxEntry[] = []

  async send(msg: SmsMessage): Promise<{ messageId: string }> {
    const id = crypto.randomUUID()
    this.messages.unshift({
      ...msg,
      id,
      created_at: new Date().toISOString(),
      code: msg.body.match(/\b\d{6,10}\b/)?.[0] ?? null,
    })
    if (this.messages.length > CAP) this.messages.length = CAP
    return { messageId: id }
  }

  list(): SmsInboxEntry[] {
    return this.messages
  }

  clear(): void {
    this.messages = []
  }

  /** Serve the dev-only SMS inbox without sharing the email inbox's transport or state. */
  serve(req: Request, url: URL): Response {
    const method = req.method.toUpperCase()
    if (url.pathname === '/sms-inbox/api/messages') {
      if (method === 'DELETE') {
        this.clear()
        return new Response(null, { status: 204 })
      }
      return Response.json({ messages: this.messages })
    }
    if (url.pathname === '/sms-inbox' || url.pathname === '/sms-inbox/') {
      return new Response(SMS_INBOX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }
}

const SMS_INBOX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SupaCloud Lite · SMS Inbox</title><style>
:root{color-scheme:dark}body{margin:0;background:#0a0a0a;color:#fafafa;font:14px/1.5 system-ui,sans-serif}
header,main{max-width:760px;margin:auto;padding:20px}.msg{border:1px solid #27272a;border-radius:12px;padding:16px;margin:12px 0}
.code{font:20px ui-monospace,monospace;letter-spacing:3px;color:#34d399}.muted{color:#a1a1aa}button{padding:6px 12px}
</style></head><body><header><h1>SupaCloud Lite · SMS Inbox</h1><p class="muted">Loopback local development only</p>
<button id="clear">Clear</button></header><main id="list">Loading…</main><script>
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){const r=await fetch('/sms-inbox/api/messages');const {messages}=await r.json();
document.getElementById('list').innerHTML=messages.length?messages.map(m=>'<div class="msg"><div class="muted">to '+esc(m.to)+' · '+esc(new Date(m.created_at).toLocaleTimeString())+'</div><div class="code">'+esc(m.code||'')+'</div></div>').join(''):'No SMS messages yet.'}
document.getElementById('clear').onclick=async()=>{await fetch('/sms-inbox/api/messages',{method:'DELETE'});load()};load();setInterval(load,4000)
</script></body></html>`
