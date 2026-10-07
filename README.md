# Batalla Psicológica

Juego web multijugador de estrategia con partidas 1 contra 1, búsqueda automática de rival, torneos de ocho participantes y espectadores.

## Requisitos

- Node.js 22 o posterior
- Un cliente OAuth 2.0 de Google de tipo aplicación web

## Instalación

```sh
npm install
cp .env.example .env
```

Edita `.env` y define `GOOGLE_CLIENT_ID` con el ID del cliente OAuth de Google. No publiques `.env` ni lo añadas a Git.

En Google Cloud Console, autoriza estos orígenes JavaScript:

- `http://localhost:3000`
- El origen HTTPS donde se despliegue el juego

Autoriza también estos URI de redirección:

- `http://localhost:3000/auth/google/callback`
- `https://TU-DOMINIO/auth/google/callback`

Inicia el servidor:

```sh
npm start
```

Abre `http://localhost:3000`. Para que otros dispositivos de la red local se conecten, inicia sesión y comparte la URL de red mostrada por el servidor. Para jugar desde Internet se necesita desplegar el servidor detrás de HTTPS y configurar `PUBLIC_URL`.

## Pruebas

```sh
npm test
```

## Datos locales

El servidor crea `data/` para la clave de sesiones, el ranking y el historial de partidas. Esta carpeta y `.env` están excluidos de Git y no se incluyen al publicar el proyecto.

## Estructura

- `server.js`: API, autenticación, salas, torneos y emparejamiento
- `public/index.html`: interfaz del juego
- `public/scene3d.js`: escena y animación Three.js
- `public/vendor/`: módulos Three.js servidos localmente
- `tests/`: pruebas de reglas y flujos HTTP
