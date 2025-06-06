# Simulación Avanzada del Sistema Solar

Este proyecto muestra una simulación 3D interactiva del sistema solar construida con [Three.js](https://threejs.org/) y un pequeño servidor Express. Incluye planetas, la Luna, cientos de asteroides e incluso cometas generados aleatoriamente.

## Características

- Visualización 3D de planetas con texturas y órbitas.
- Cometas, asteroides y efectos especiales como anillos o glow solar.
- Controles para pausar la simulación, ajustar la velocidad del tiempo y alternar órbitas o "trails".
- Minimap integrado e indicador de escala.
- Modo de agregado para crear cuerpos personalizados tocando la escena.
- Compatible con dispositivos móviles (gestos táctiles).

## Instalación

```bash
npm install
```

## Uso

Ejecuta el servidor con:

```bash
npm start
```

Luego abre [`http://localhost:3000`](http://localhost:3000) en tu navegador favorito para ver la simulación.

Para desarrollo continuo puedes usar:

```bash
npm run dev
```

(corre el servidor con `nodemon` y recarga automáticamente al cambiar `server.js`).

### GitHub Pages

Para probar la simulación en GitHub Pages basta con subir el contenido del repositorio y utilizar `main.html` como archivo de entrada. De esta forma podrás ver la demo sin necesidad de un servidor Node.

## ¿Qué se puede hacer?

- Explorar el sistema solar con rotación, zoom y paneo.
- Ajustar la velocidad de avance temporal o pausar la simulación.
- Activar "Modo Agregar" para insertar nuevos cuerpos celestes.
- Visualizar información detallada de cada objeto al seleccionarlo.
- Reiniciar la simulación o eliminar cometas con un clic.

¡Experimenta añadiendo cometas, fusiones de planetas y modificando los parámetros para crear sistemas solares únicos!

## Mejoras futuras

- Guardar configuraciones personalizadas en `localStorage`.
- Añadir sonidos ambientales opcionales.
- Mostrar estadísticas y datos históricos de la simulación.

¡Disfruta explorando el cosmos!
