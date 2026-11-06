# Phone Check ES

PWA para consultar un móvil español: validación local + estado de la línea y operadora vía HLR.

## Archivos
- `index.html`: la PWA (GitHub Pages: Settings → Pages → Branch `main` / root).
- `worker/`: proxy Cloudflare Worker que guarda las claves del proveedor.

## Desplegar el proxy
```bash
cd worker
npx wrangler login
npx wrangler secret put PROXY_TOKEN        # inventa un token largo
npx wrangler secret put HLR_API_KEY        # solo si usas HLRLookup.com
npx wrangler secret put HLR_API_SECRET
npx wrangler secret put TWILIO_API_KEY     # solo si usas Twilio
npx wrangler secret put TWILIO_API_SECRET
npx wrangler deploy
```
Wrangler imprime la URL, tipo `https://phonecheck-proxy.<tu-subdominio>.workers.dev`.

En la PWA: **Ajustes** → proveedor, URL del Worker y `PROXY_TOKEN` → Guardar.

Si sirves la PWA desde otro dominio, cambia `ALLOWED_ORIGIN` en `wrangler.toml`.

## Prueba rápida
```bash
curl -X POST https://TU-WORKER.workers.dev \
  -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" \
  -d '{"provider":"hlrlookup","number":"+34600000000"}'
```

## Notas
- HLRLookup devuelve estado, operadora actual y original, portabilidad y tipo. Twilio (Lookup v2) devuelve operadora y tipo, y el estado con `line_status` (beta pública; prueba la cobertura en España).
- Cada consulta consume créditos del proveedor.

## Contactos
Los contactos importados (.vcf o selector del móvil) se guardan solo en el `localStorage` del dispositivo y no se envían al proxy. El botón «Borrar» los elimina.
