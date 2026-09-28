# Red Box

Monitor local de dispositivos del Sagemcom F@ST 3890 V3 CVA: router → SQLite → dashboard → Telegram. Sin dependencias npm, sin frameworks ni módulos nativos externos. No modifica la configuración del router. Usa únicamente los tres paths del router proporcionados por el usuario.

## Archivos

- `server.js`: servidor HTTP, archivos estáticos y API interna del dashboard.
- `config.json`, `lib/config.js`, `.env.example`: configuración y carga de secretos.
- `lib/router/sagemcom.js`: login, cookies, HTTPS local, parser y diagnóstico.
- `lib/db.js`: SQLite con devices, events y alerts.
- `lib/monitor.js`: polling secuencial y alertas por cambios.
- `lib/telegram.js`: Bot API, prueba, validación y cooldown persistente.
- `lib/telegram-commands.js`: comandos autorizados y notificación de actualizaciones.
- `lib/cloudflare.js`, `lib/process-state.js`: URL del túnel y verificación de procesos.
- `lib/update.js`, `scripts/update.sh`, `scripts/update-worker.js`: actualización, rollback y recuperación.
- `scripts/start-cloudflare.sh`, `scripts/stop-cloudflare.sh`, `scripts/services.js`: administración de procesos con PID y locks.
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

No hace falta `npm install`. La versión objetivo es Node 26. Las pruebas en el entorno de desarrollo se ejecutaron con Node 25.9.0; la integración Sagemcom existente se conserva. Las nuevas funciones remotas deben validarse en tu TV Box.

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

El servidor escucha por defecto en `0.0.0.0:8080`. Abrir `http://127.0.0.1:8080` en la TV Box o `http://IP_DE_LA_TV_BOX:8080` desde otro equipo de confianza en la misma LAN. Esta primera versión no tiene autenticación del dashboard: los equipos con acceso pueden editar metadatos y enviar pruebas de Telegram. El Quick Tunnel publica este mismo dashboard: cualquiera que conozca la URL puede acceder y editar sus metadatos. La autorización por TELEGRAM_CHAT_ID protege los comandos del bot, no la web. No se abren puertos en el router.

El puerto se resuelve con prioridad `PORT` → `config.json` → `8080`. Por ejemplo, `PORT=9090 node server.js` inicia en el puerto 9090. También se puede definir `PORT` en `.env`. Si se cambia el puerto, usar ese valor en la URL del dashboard. Cloudflare y Termux:Boot están fijados a 8080: para esas funciones mantené PORT=8080 (o no lo definas) y config.json en 8080.

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

El script asume `$HOME/red-box`, toma wake lock, espera 10 segundos para que haya red, recupera una actualización interrumpida si hay un journal pendiente, inicia Red Box, espera hasta 60 intentos de respuesta en localhost:8080 y luego inicia Cloudflare. PID, identidad de proceso y locks evitan duplicados. La red puede demorar más: si falla el arranque, revisar data/cloudflared.log y volver a ejecutar los scripts. Ajustar la ruta si es diferente. Permitir actividad en segundo plano y desactivar optimización de batería para Termux en Android. Android puede detener procesos; estos scripts no son un supervisor ni garantizan disponibilidad 24/7. Documentación: [Termux:Boot](https://github.com/termux/termux-boot).

## Pruebas sin hardware

```bash
npm test
node test/red-box.test.js
```

Cubren Base64, cookies, login, expiración/reautenticación, parser, SQLite, cambios, Telegram, cooldown, exclusión de polling simultáneo, autorización de comandos, URL/PID/locks, actualizaciones y rollback. Las pruebas de procesos crean directorios y repositorios temporales; requieren Git, npm y Bash. El comando npm test ejecuta solamente archivos *.test.js para no ejecutar los fixtures de procesos como suites independientes. Las solicitudes de prueba están simuladas, no contactan al router ni a Telegram.

La API interna creada para el dashboard es GET `/api/state`, PATCH `/api/devices/:id`, PATCH `/api/settings` y POST `/api/telegram/test`. No son endpoints atribuidos al router. No hay SSH, Docker, PM2, nmap, agentes ni Tailscale.


## Acceso remoto: Cloudflare Quick Tunnel

Conservar tu Node funcional. Instalar las herramientas adicionales desde Termux:

```bash
pkg install cloudflared git curl
cloudflared --version
git --version
```

La disponibilidad del paquete depende de tu versión de Android y repositorios de Termux. No se descarga ni se ejecuta automáticamente ningún binario alternativo. Si cloudflared no funciona en ese Android/ARMv7, resolver esa compatibilidad antes de activar el arranque automático.

Prueba manual, con Red Box ya escuchando en 8080:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

Detener esa prueba con Ctrl+C antes de usar los scripts. Los scripts no adoptan ni detienen túneles manuales ajenos.

```bash
bash scripts/start-cloudflare.sh
bash scripts/stop-cloudflare.sh
```

El inicio espera hasta 60 segundos por una URL `https://xxxxx.trycloudflare.com` y la escribe en `data/cloudflare-url.txt`. El archivo y el log se reemplazan al iniciar un túnel nuevo. Si falla, el script termina con error, intenta cerrar su proceso y deja el motivo en `data/cloudflared.log`. El PID queda en `data/cloudflared.pid`; `data/cloudflared-state.json` guarda identidad, inicio del proceso y argumentos para rechazar PIDs reutilizados. No se usa pkill. Un PID que no se pueda verificar nunca se mata.

Cloudflare recibe un entorno sin las credenciales de Red Box y un HOME aislado (`data/cloudflare-home`) para no cargar configuraciones de túneles o tokens ajenos. El destino está fijado en `http://127.0.0.1:8080`. Los scripts de Red Box usan la misma verificación de identidad para `data/red-box.pid` y migran PIDs antiguos solo si su comando y directorio coinciden exactamente con este proyecto.

Quick Tunnel genera una URL aleatoria que puede cambiar al reiniciar. Es una función de prueba, sin garantía de disponibilidad; no requiere abrir puertos del router. Consultar [Quick Tunnels de Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Un PID activo no garantiza conectividad con Cloudflare: `/url` verifica proceso y URL local, no realiza una comprobación pública del túnel.

## Comandos entrantes de Telegram

Se reutilizan TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID. El chat ID debe ser su valor numérico exacto (con `-` si corresponde), no un nombre de usuario. Solo ese chat recibe respuestas y puede ejecutar comandos. Si es un grupo, sus participantes pueden enviar esos comandos; usar un chat privado para limitarlo a una persona.

- `/url`: devuelve la URL del proceso Cloudflare administrado, o informa que no hay túnel activo.
- `/status`: estado breve de Red Box, router, cantidad de dispositivos y túnel.
- `/update`: actualización desde origin/main, sin argumentos.

No existe shell remota. `/exec`, `/shell`, `/bash`, `/cmd` y argumentos de `/update` no se ejecutan. No se envían tokens, .env, cookies, direcciones de dispositivos ni dumps de subprocessos.

El bot recibe mensajes mediante [getUpdates de Telegram](https://core.telegram.org/bots/api#getupdates), con long polling sin solapamientos. Debe estar dedicado a esta instancia de Red Box, sin otro consumidor ni webhook activo. Los errores de consulta se reintentan; no se elimina un webhook automáticamente. En la primera activación se descarta la cola antigua para evitar ejecutar un `/update` viejo; después el offset persiste en SQLite y se avanza antes de ejecutar el comando. Los comandos no requieren la prueba de alertas: las alertas automáticas conservan su validación previa existente.

## Actualización remota desde GitHub

Primero desplegar estos archivos en la TV Box y publicarlos en tu repositorio GitHub: el actualizador no crea ni publica un repositorio. Configurar `origin` y asegurar que `origin/main` sea la versión que querés instalar. Para repositorios privados, Git debe tener acceso no interactivo ya configurado; no colocar tokens en una URL versionada o en los scripts.

Requisitos:

- Red Box debe ejecutarse con `bash start.sh`, no en primer plano con `node server.js`.
- El working tree debe estar limpio: los cambios locales de código/config.json deben estar confirmados o resueltos antes. Los valores persistentes y privados van en .env y data/.
- .env y data/ deben estar ignorados y no versionados, tanto en la versión actual como en la candidata.
- Mantener el servicio en 8080 y espacio libre para la versión candidata y, si existen, dos copias de node_modules durante el reemplazo.

Al enviar `/update`:

1. El bot confirma `Actualizando Red Box...` y lanza un worker separado mediante `scripts/update.sh`, con argumentos fijos.
2. Un lock impide dos actualizaciones simultáneas. Se ejecuta `git fetch origin` y se verifica `origin/main`.
3. Se extrae el commit candidato en un directorio temporal dentro de data/. Allí se ejecuta `npm ci` si tiene package-lock.json; si no, `npm install --package-lock=false`. Luego se ejecuta `npm test`.
4. Si falla instalación o tests, la app actual sigue funcionando. Solo se guarda un resultado de fallo por etapa; no se mandan logs crudos.
5. Si pasa, se comprueba otra vez que no aparecieron cambios locales, se guarda un journal, se detiene solamente Red Box, se aplica `git reset --hard` al commit ya probado, se instalan las dependencias preparadas y se reinicia.
6. Solo después de verificar el nuevo proceso y la respuesta HTTP se marca éxito. Si falla el reinicio, se intenta restaurar el commit y las dependencias anteriores.
7. `data/update-result.json` permite que el bot reiniciado mande el resultado final y el commit corto. El envío se reintenta si Telegram no está disponible. La recepción de comandos se interrumpe durante el reinicio; la actualización no se repite por el mismo offset.

Cloudflare permanece ejecutándose durante el reinicio; el dashboard puede devolver un error breve mientras Red Box vuelve a iniciar. `data/update.log` registra etapas y resultados, sin salida cruda de Git/npm/tests ni credenciales. El worker usa un entorno limitado sin los secretos de Red Box; la nueva aplicación carga su .env preservado al iniciar.

Si el equipo se apaga durante el reemplazo, Termux:Boot consulta `data/update-journal.json` e intenta recuperar la versión anterior. Si la recuperación no puede completarse, se conservan journal y backup para intervención local; nunca se anuncia éxito. Los cortes de energía o fallos del almacenamiento no ofrecen una garantía transaccional del sistema de archivos.

Para recuperar manualmente una actualización interrumpida:

```bash
node scripts/update-worker.js --recover
```

No borrar los archivos update-* mientras haya una actualización o recuperación pendiente. No se usa `git clean`, y ni .env ni data/ se reemplazan con contenido del repositorio.
