# Red Box — primera versión

Monitor local de dispositivos del Sagemcom F@ST 3890 V3 CVA: router → SQLite → dashboard → Telegram. Sin dependencias npm, sin frameworks ni módulos nativos externos. No modifica la configuración del router. Usa únicamente los tres paths del router proporcionados por el usuario.

## Archivos

- `server.js`: servidor HTTP, archivos estáticos y API interna del dashboard.
- `config.json`, `lib/config.js`, `.env.example`: configuración y carga de secretos.
- `lib/router/sagemcom.js`: login, cookies, HTTPS local, parser y diagnóstico.
- `lib/db.js`: SQLite con devices, events y alerts.
- `lib/monitor.js`: polling secuencial y alertas por cambios.
- `lib/telegram.js`: Bot API, prueba, validación y cooldown persistente.
- `public/index.html`, `public/app.js`, `public/styles.css`: cuatro pestañas sin frameworks.
- `start.sh`, `stop.sh`, `restart.sh`, `scripts/termux-boot.sh`: ejecución con PID file.
- `test/red-box.test.js`, `test/fixtures/*.html`: pruebas locales y HTML representativo.
- `.gitignore`, `package.json`, `README.md`.

## Instalación en Termux

Copiar esta carpeta a `$HOME/red-box` en la TV Box. Si ya tenés Node 26 funcional, conservá esa instalación. Si falta Node, el paquete disponible se instala con `pkg install nodejs`; verificá la versión y SQLite antes de continuar: no se garantiza que los repositorios entreguen Node 26 para cada dispositivo ARMv7.

```bash
pkg update
pkg install nodejs nano
cd "$HOME/red-box"
node --version
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); console.log(db.prepare('select sqlite_version() as version').get()); db.close()"
cp .env.example .env
chmod 600 .env
nano .env
npm test
node server.js
```

No hace falta `npm install`. La versión objetivo es Node 26. Las pruebas en el entorno de desarrollo se ejecutaron con Node 25.9.0; falta verificar Node 26 + ARMv7 y el router real en la TV Box.

`.env`:

```dotenv
ROUTER_URL=https://192.168.0.1
ROUTER_USERNAME=custadmin
ROUTER_PASSWORD="tu contraseña real"
TELEGRAM_BOT_TOKEN="tu token real"
TELEGRAM_CHAT_ID="tu chat ID real"
```

Usar comillas si hay `#` o espacios en valores. Reiniciar después de cambiar `.env`. Nunca se envía este archivo al frontend. Contraseña, cookies y token del bot no se almacenan en SQLite. La tabla alerts guarda una huella SHA-256 de token + chat para invalidar la validación al cambiar credenciales; no guarda el token.

## Arranque y dashboard

```bash
bash start.sh
bash stop.sh
bash restart.sh
```

El PID queda en `data/red-box.pid` y el log en `data/red-box.log`. No ejecutar `node server.js` y `start.sh` simultáneamente. `stop.sh` administra el proceso iniciado por `start.sh`; para ejecución en primer plano, Ctrl+C.

El servidor escucha por defecto en `0.0.0.0:8080`. Abrir `http://127.0.0.1:8080` en la TV Box o `http://IP_DE_LA_TV_BOX:8080` desde otro equipo de confianza en la misma LAN. Esta primera versión no tiene autenticación del dashboard: los equipos con acceso pueden editar metadatos y enviar pruebas de Telegram. No publicar ese puerto en Internet.

El puerto se resuelve con prioridad `PORT` → `config.json` → `8080`. Por ejemplo, `PORT=9090 node server.js` inicia en el puerto 9090. También se puede definir `PORT` en `.env`. Si se cambia el puerto, usar ese valor en la URL del dashboard.

`config.json`: polling 60 segundos después de finalizar cada ciclo, timeout 15 segundos por solicitud, umbral de router no disponible 3 ciclos, cooldown inicial 300 segundos. El cooldown también se puede editar en Configuración y queda persistido. El cooldown es por tipo de alerta y dispositivo; recuperación y desaparición tienen claves distintas. Alertas dentro del cooldown se omiten, no se encolan. Los intentos fallidos también se limitan. Nuevos dispositivos de la primera lectura se registran; solo se notifican si Telegram ya estaba validado.

## Probar el router real

1. Completar las variables ROUTER en `.env` desde la misma TV Box donde funcionó curl.
2. Ejecutar `node server.js` y observar el primer ciclo (inmediato).
3. Esperar estos diagnósticos, sin valores de cookies:

```text
Sagemcom GET /index.php -> 200
Sagemcom cookies: PHPSESSID=true csrfp_token=true
Sagemcom POST /check.php -> 302 Location=main.php
Sagemcom GET /connected_devices_computers.php -> 200
Sagemcom dispositivos parseados: N
```

4. Comparar Inicio y Dispositivos con la página del router: MAC, hostname, IP, conexión, RSSI y asignación.
5. Desconectar y reconectar un dispositivo de prueba; comprobar eventos en los ciclos siguientes. Ante un fallo del router se conserva el último estado conocido. Tras tres fallos aparece un evento Router no disponible; la recuperación genera otro evento.

GET index obtiene cookies; POST check envía username, password Base64 UTF-8 y csrfp_token con esas cookies. Se exige 302 hacia main.php en el mismo origen. Las cookies permanecen en memoria. Una respuesta de sesión expirada provoca un único reintento de login. HTTPS usa un `https.Agent` privado con `rejectUnauthorized:false` solo para estas solicitudes al router. Telegram usa TLS normal. No se usa NODE_TLS_REJECT_UNAUTHORIZED.

Errores: TLS, TIMEOUT, CONNECTION_REFUSED, CONNECTION, LOGIN, COOKIES_MISSING, TOKEN_MISSING, SESSION_EXPIRED, HTML_UNEXPECTED y PARSER. Logs con name, code, message y cause saneados. No se imprime HTML crudo ni cuerpos del login.

Los fixtures son sintéticos, basados en los nombres de variables proporcionados: **no son una captura del firmware real**. El parser exige arrays de strings, cantidad consistente y MAC válidas; extrae datos de filas `tr` que contienen la MAC. Campos ausentes se guardan como null. Si el firmware usa otra disposición, habrá que ajustar el parser con una copia anonimizada del HTML real. No interpreta un HTML de error como cero dispositivos. No usa eval.

## Probar Telegram

1. Completar TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID y reiniciar.
2. Abrir Configuración → Enviar mensaje de prueba.
3. Confirmar el mensaje `Red Box: Telegram funcionando correctamente.` y estado `validado`.
4. Si falla, se muestra HTTP y descripción de Telegram (o fallo de conexión/timeout). No se habilitan alertas hasta una prueba exitosa.
5. Marcar crítico un dispositivo y probar desconexión/reconexión. Las alertas permitidas son nuevo dispositivo, crítico desaparecido/reaparecido y router no disponible/recuperado.

Se usa directamente [sendMessage de Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).

## SQLite y consumo

`data/red-box.sqlite` usa [node:sqlite](https://nodejs.org/api/sqlite.html), WAL y transacciones por lectura válida. MAC única identifica cada dispositivo. Se actualiza estado/last_seen en cada lectura; solo se crean eventos por altas, offline, recovery, IP, conexión y hostname. RSSI no genera eventos. Alias, categoría y crítico son metadatos locales. Los eventos se conservan; revisar periódicamente espacio disponible y tamaño del log en uso 24/7.

## Termux:Boot

Instalar y abrir Termux:Boot desde una fuente compatible con tu instalación de Termux. Luego:

```bash
mkdir -p "$HOME/.termux/boot"
cp "$HOME/red-box/scripts/termux-boot.sh" "$HOME/.termux/boot/red-box.sh"
chmod 700 "$HOME/.termux/boot/red-box.sh"
```

El script asume `$HOME/red-box`, toma wake lock y ejecuta start.sh. Ajustar la ruta si es diferente. Permitir actividad en segundo plano y desactivar optimización de batería para Termux en Android. Android puede detener procesos; estos scripts no son un supervisor ni garantizan disponibilidad 24/7. Documentación: [Termux:Boot](https://github.com/termux/termux-boot).

## Pruebas sin hardware

```bash
npm test
node test/red-box.test.js
```

Cubren Base64, cookies, login, expiración/reautenticación, parser, SQLite, cambios, Telegram, cooldown y exclusión de polling simultáneo. Las solicitudes de prueba están simuladas, no contactan al router ni a Telegram.

La API interna creada para el dashboard es GET `/api/state`, PATCH `/api/devices/:id`, PATCH `/api/settings` y POST `/api/telegram/test`. No son endpoints atribuidos al router. No hay SSH, Docker, PM2, nmap, agentes ni Tailscale.
