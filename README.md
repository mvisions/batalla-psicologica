# Batalla Psicológica

Juego web multijugador de estrategia con partidas 1 contra 1, búsqueda automática de rival, torneos de cuatro y ocho participantes y espectadores. El torneo de cuatro participantes se juega con dos semifinales, una final y un partido por el tercer puesto. Tras cinco minutos de inscripción, los puestos vacantes se completan con Lamine (bandera española, nivel medio), Messi (bandera argentina, nivel fácil) y Ronaldo (bandera portuguesa, nivel máximo); los bots juegan automáticamente.

## Requisitos

- Node.js 22 o posterior
- Clientes OAuth de Google para Web y Android
- Java 21 y Android SDK API 36 para compilar Android

## Instalación

```sh
npm install
cp .env.example .env
```

Edita `.env` y define `GOOGLE_CLIENT_ID` con el ID OAuth Web. `GOOGLE_ANDROID_CLIENT_ID` sirve como referencia del cliente Android registrado en Google Cloud; el plugin nativo usa el ID Web como audiencia del token. En local puedes dejar vacíos `SESSION_SECRET`, `PUBLIC_URL` y `API_BASE_URL`; el servidor crea su clave local y sirve la app desde el mismo origen. No publiques `.env` ni lo añadas a Git.

En Google Cloud Console, autoriza estos orígenes JavaScript:

- `http://localhost:3000`
- El origen HTTPS donde se despliegue el juego

Autoriza también estos URI de redirección:

- `http://localhost:3000/auth/google/callback`
- `https://TU-DOMINIO/auth/google/callback`

En la pantalla de consentimiento, agrega las cuentas que probarán el inicio de sesión mientras la app esté en modo de prueba.

Inicia el servidor:

```sh
npm start
```

Abre `http://localhost:3000`. Para que otros dispositivos de la red local se conecten, inicia sesión y comparte la URL de red mostrada por el servidor. Para jugar desde Internet se necesita desplegar el servidor detrás de HTTPS y configurar `PUBLIC_URL`.

## Android

El wrapper usa Capacitor y el paquete `com.mvisions.batallapsicologica`. Google Cloud tiene un cliente Android de depuración registrado para ese paquete y la SHA-1 del debug keystore local. El plugin nativo envía el ID token del cliente Web al backend para verificar la cuenta.

```sh
npm run android:add
npm run android:sync
npm run android:build
```

`android:add` se ejecuta una sola vez. El APK debug se genera en `android/app/build/outputs/apk/debug/app-debug.apk`.

`CAPACITOR_SERVER_URL` apunta por defecto al backend del emulador Android (`http://10.0.2.2:3000`). Para probar en un teléfono físico, cambia `CAPACITOR_SERVER_URL` en `.env` por la IP LAN del servidor, vuelve a ejecutar `npm run android:sync` e instala el APK en un dispositivo de la misma red.

Para producción se necesita desplegar el backend Node detrás de HTTPS, definir `PUBLIC_URL` y `CAPACITOR_SERVER_URL`, y volver a sincronizar/compilar. GitHub Pages por sí solo no ejecuta la API. Las compilaciones release y Play App Signing requieren clientes Android registrados con las SHA-1 de sus certificados correspondientes. Mientras el consentimiento OAuth esté en modo de prueba, agrega las cuentas de prueba en Google Auth Platform.

## Publicación web

La web estática se publica desde GitHub Pages; el servidor Node va como Web Service en Render. Despliega `render.yaml` como Blueprint y configura `GOOGLE_CLIENT_ID` en Render; genera `SESSION_SECRET` como secreto. No subas `.env`.

En Render configura (el Blueprint prepara estos valores; introduce `GOOGLE_CLIENT_ID` y deja que Render genere `SESSION_SECRET`):

- `API_BASE_URL`: URL HTTPS del Web Service
- `PUBLIC_URL`: `https://mvisions.github.io/batalla-psicologica/`
- `ALLOWED_ORIGINS`: `https://mvisions.github.io`
- `RANKING_STORAGE`: `firestore`
- `GOOGLE_CLOUD_PROJECT`: `ayta-510923`
- `GOOGLE_APPLICATION_CREDENTIALS`: `/etc/secrets/render-ranking-key.json`

Sube la clave JSON de la cuenta de servicio `render-ranking` como Secret File llamado `render-ranking-key.json` en Render. Esa cuenta debe tener únicamente el rol `Cloud Datastore User`. En desarrollo local, deja `RANKING_STORAGE=file`; el servidor usa `data/ranking.json` y `data/profiles.json`.

En GitHub activa Pages con GitHub Actions. El workflow publica `dist/`; define las variables de repositorio `BATALLA_API_URL` y `BATALLA_PUBLIC_URL` si las URLs difieren de las predeterminadas. En Google Cloud autoriza `https://mvisions.github.io` como origen JavaScript y `https://TU-SERVICIO.onrender.com/auth/google/callback` como URI de redirección.

Cada vista del ranking (`Siempre` y `Esta semana`) conserva como máximo 20 marcas. Una marca nueva solo entra si supera estrictamente el puesto 20; al entrar, la última sale de la clasificación. Los puntos y el perfil del jugador se conservan aparte.

El ranking y los perfiles se guardan en Firestore. Su cuota gratuita incluye hasta 1 GiB, 50.000 lecturas y 20.000 escrituras al día; el exceso se factura a Google Cloud. Render Free sigue usando almacenamiento efímero para el historial de partidas, que puede reiniciarse al dormir o redeplegar el servicio.

## Pruebas

```sh
npm test
```

## Datos locales

El servidor crea `data/` para la clave local de sesiones, las listas del ranking, los perfiles y el historial de partidas. En producción, el ranking y los perfiles se sincronizan con Firestore; esta carpeta y `.env` están excluidos de Git y no se incluyen al publicar el proyecto.

## Estructura

- `server.js`: API, autenticación, salas, torneos y emparejamiento
- `public/index.html`: interfaz del juego
- `public/scene3d.js`: escena y animación Three.js
- `public/vendor/`: módulos Three.js servidos localmente
- `tests/`: pruebas de reglas y flujos HTTP
