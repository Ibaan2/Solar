  window.onload = () => {
    ///////////////////////////////////
    // 1. CONSTANTES Y PARÁMETROS
    ///////////////////////////////////
    const G = 39.47841760435743;      // UA^3 / (M_sun * año^2)
    let scaleDistance = 80;           // 1 UA = 80 unidades Three.js
    const radiusScale   = 2000;       // 1 UA → 2000 unidades, para radios
    let timeStep = 0.001;             // Años/frame (inicial: 0.001)
    let simTime = 0;                  // Tiempo simulado en “años”
    let simRunning = true;            // Control de play/pause
    const bodies = [];                // Array con todos los cuerpos activos
    const comets = [];                // Array con cometas generados

    let scene, camera, renderer, controls, raycaster;
    const touch = new THREE.Vector2();
    const planeY = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // plano Y=0

    let addMode = false;      // Si true, toques agregan cuerpos
    let showOrbits = true;
    let showTrails = true;
    const axisHelper = new THREE.AxesHelper(300); // Ejes X/Y/Z

    // Mapa de inclinaciones reales aproximadas de órbitas (en grados)
    const orbitInclinations = {
      'Mercurio': 7.00,
      'Venus':    3.39,
      'Tierra':   0.00,
      'Marte':    1.85,
      'Júpiter':  1.31,
      'Saturno':  2.49,
      'Urano':    0.77,
      'Neptuno':  1.77,
      'Luna':     5.15
    };

    ///////////////////////////////////
    // 2. CLASE "Cuerpo"
    ///////////////////////////////////
    class Cuerpo {
      constructor({ nombre, masa, radioUA, posicionUA, velocidadUA, color, tipo, hasRings, textureURL }) {
        this.nombre = nombre;
        this.masa = masa;            // en masas solares (M_sun)
        this.radioUA = radioUA;      // radio real en UA (colisiones)
        this.pos = { ...posicionUA };// {x, y, z} en UA
        this.vel = { ...velocidadUA };// {x, y, z} en UA/año
        this.tipo = tipo || 'genérico';
        this.hasRings = hasRings || false; 
        this.textureURL = textureURL || null;
        this._markeoParaEliminar = false;

        // 2.1. Malla (esfera) con textura si se proporciona
        const radioDisplay = Math.max(radioUA * radiusScale, 0.3); 
        const geom = new THREE.SphereGeometry(radioDisplay, 64, 64);
        let mat;
        if (textureURL) {
          const tex = new THREE.TextureLoader().load(textureURL);
          mat = new THREE.MeshPhongMaterial({
            map: tex,
            shininess: 10,
            specular: 0x222222
          });
        } else {
          mat = new THREE.MeshPhongMaterial({
            color: color,
            shininess: 30,
            specular: 0x333333
          });
        }
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.position.set(
          this.pos.x * scaleDistance,
          this.pos.y * scaleDistance,
          this.pos.z * scaleDistance
        );
        // Almacenamos referencia al objeto "Cuerpo" para raycast
        this.mesh.userData = { cuerpo: this };
        scene.add(this.mesh);

        // 2.2. Órbita de referencia (planetas y luna)
        const inc = orbitInclinations[this.nombre] || 0;
        if (tipo === 'planeta' || tipo === 'luna') {
          this.orbitLine = dibujarOrbita(radioDisplay, inc);
        }

        // 2.3. Trayectoria (trail): hasta 200 puntos (400 para cometas)
        this.trailMaxPoints = (tipo === 'cometa') ? 400 : 200;
        this.trailPositions = [];
        this.trailGeometry = new THREE.BufferGeometry();
        this.trailMaterial = new THREE.LineBasicMaterial({
          color: color,
          linewidth: (tipo === 'cometa') ? 2 : 1
        });
        this.trailLine = new THREE.Line(this.trailGeometry, this.trailMaterial);
        scene.add(this.trailLine);

        // 2.4. Añadir anillos si es Saturno
        if (hasRings) {
          const inner = radioDisplay * 1.25;
          const outer = radioDisplay * 2.25;
          const ringGeo = new THREE.RingGeometry(inner, outer, 128);
          ringGeo.rotateX(-Math.PI / 2);
          const ringMat = new THREE.MeshBasicMaterial({
            map: new THREE.TextureLoader().load('https://i.imgur.com/7XG7Yqu.png'),
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.8
          });
          this.ringMesh = new THREE.Mesh(ringGeo, ringMat);
          this.mesh.add(this.ringMesh);
        }

        // 2.5. Si es agujero negro, creamos disco de acreción y esfera de Roche
        if (tipo === 'bn') {
          this.crearDiscoAcrecion(radioDisplay);
          this.crearZonaRoche();
        }
        // Si es enana blanca o estrella de neutrones, creamos zona de Roche
        if (tipo === 'enanaBlanca' || tipo === 'ns') {
          this.crearZonaRoche();
        }
      }

      // 2.6. Creación del disco de acreción (solo BH)
      crearDiscoAcrecion(radioDisplay) {
        // Torus giratorio para simular disco
        const diskInner = radioDisplay * 1.5;
        const diskOuter = radioDisplay * 3.0;
        const torusGeo = new THREE.TorusGeometry((diskInner + diskOuter) / 2, (diskOuter - diskInner) / 2, 16, 100);
        const diskTex = new THREE.TextureLoader().load('https://i.imgur.com/4X8oYWq.png'); // textura de disco
        const torusMat = new THREE.MeshBasicMaterial({
          map: diskTex,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.7
        });
        this.acretionDisk = new THREE.Mesh(torusGeo, torusMat);
        this.acretionDisk.rotation.x = Math.PI / 2;
        this.acretionDisk.position.set(0, 0, 0);
        this.mesh.add(this.acretionDisk);
      }

      // 2.7. Creación de la zona de Roche (para enana blanca, NS y BH)
      crearZonaRoche() {
        // Distancia de Roche aproximada (para un cuerpo con densidad ~ 5500 kg/m³)
        // d₁ ≈ R_compacto * (ρ_compacto / ρ_objeto)^(1/3). Simplificamos poniendo ρ_compacto enorme → d ~ 1.5*R_lagrange
        // Para BH, tomamos rSchwarzschild * 50; para enana blanca o NS, rAprox * 100
        let rocheRadiusUA;
        if (this.tipo === 'bn') {
          const rschMeters = 2 * 6.67430e-11 * (this.masa * 1.98847e30) / (299792458**2);
          const rschUA = rschMeters / 1.495978707e11;
          rocheRadiusUA = rschUA * 50;
        } else {
          // Tomamos radioUA * 5 como abarque de marea
          rocheRadiusUA = this.radioUA * 5;
        }
        const rocheDisplay = rocheRadiusUA * scaleDistance;
        const geo = new THREE.SphereGeometry(rocheDisplay, 32, 32);
        const mat = new THREE.MeshBasicMaterial({
          color: 0xff4444,
          wireframe: true,
          transparent: true,
          opacity: 0.3
        });
        this.rocheSphere = new THREE.Mesh(geo, mat);
        this.mesh.add(this.rocheSphere);
      }

      // 2.8. Cálculo de aceleración neta (Newton) (los cometas no atraen)
      calculaAceleracion() {
        const a = { x: 0, y: 0, z: 0 };
        for (let otro of bodies) {
          if (otro === this) continue;
          if (otro.tipo === 'cometa') continue; 

          const dx = otro.pos.x - this.pos.x;
          const dy = otro.pos.y - this.pos.y;
          const dz = otro.pos.z - this.pos.z;
          const dist2 = dx*dx + dy*dy + dz*dz;
          const dist = Math.sqrt(dist2);
          if (dist === 0) continue;

          // Si “otro” es BH, comprobar horizonte de eventos
          if (otro.tipo === 'bn') {
            const rschMeters = 2 * 6.67430e-11 * (otro.masa * 1.98847e30) / (299792458**2);
            const rschUA = rschMeters / 1.495978707e11;
            if (dist < rschUA) {
              this._markeoParaEliminar = true;
              return a;
            }
          }

          // Fuerza gravitacional newtoniana
          const aMag = G * otro.masa / dist2;
          a.x += aMag * (dx / dist);
          a.y += aMag * (dy / dist);
          a.z += aMag * (dz / dist);
        }
        return a;
      }

      // 2.9. Actualizar (física + rotaciones + trails + disco giratorio + zona Roche)
      actualizar(dt) {
        if (this._markeoParaEliminar) return;

        // Física
        const a = this.calculaAceleracion();
        this.vel.x += a.x * dt;
        this.vel.y += a.y * dt;
        this.vel.z += a.z * dt;
        this.pos.x += this.vel.x * dt;
        this.pos.y += this.vel.y * dt;
        this.pos.z += this.vel.z * dt;

        // Actualizar posición de la malla
        this.mesh.position.set(
          this.pos.x * scaleDistance,
          this.pos.y * scaleDistance,
          this.pos.z * scaleDistance
        );

        // Rotaciones propias
        if (this.tipo === 'asteroide') {
          this.mesh.rotation.y += 0.012; 
        }
        if (this.tipo === 'luna' || this.tipo === 'planeta') {
          this.mesh.rotation.y += 0.004; 
        }

        // Animar disco de acreción si existe
        if (this.acretionDisk) {
          this.acretionDisk.rotation.z += 0.02;
        }

        // Trails
        const scaledPos = new THREE.Vector3(
          this.pos.x * scaleDistance,
          this.pos.y * scaleDistance,
          this.pos.z * scaleDistance
        );
        this.trailPositions.push(scaledPos.clone());
        if (this.trailPositions.length > this.trailMaxPoints) {
          this.trailPositions.shift();
        }
        this.trailGeometry.setFromPoints(this.trailPositions);
        this.trailLine.visible = showTrails;

        // Órbitas
        if (this.orbitLine) {
          this.orbitLine.visible = showOrbits;
        }

        // Zona de Roche: si un planeta o planetaExtra entra, se fragmenta
        if ((this.tipo === 'planeta' || this.tipo === 'planetaExtra' || this.tipo === 'luna') && this.orbitLine) {
          // Buscamos si existe algún cuerpo compacto cercano
          bodies.forEach(compact => {
            if (compact === this) return;
            if (compact.tipo === 'bn' || compact.tipo === 'enanaBlanca' || compact.tipo === 'ns') {
              // Calcular distancia al compacto
              const dx = this.pos.x - compact.pos.x;
              const dy = this.pos.y - compact.pos.y;
              const dz = this.pos.z - compact.pos.z;
              const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
              // Distancia de Roche en UA
              let rocheDistUA;
              if (compact.tipo === 'bn') {
                const rschMeters = 2 * 6.67430e-11 * (compact.masa * 1.98847e30) / (299792458**2);
                const rschUA = rschMeters / 1.495978707e11;
                rocheDistUA = rschUA * 50;
              } else {
                rocheDistUA = compact.radioUA * 5;
              }
              if (dist < rocheDistUA && !this._markeoParaEliminar) {
                // Fragmentar en meteoritos: entre 5 y 10 piezas
                const nFrag = 5 + Math.floor(5 * Math.random());
                const masaEach = this.masa / nFrag;
                for (let i = 0; i < nFrag; i++) {
                  const angle = 2 * Math.PI * (i / nFrag);
                  const offset = rocheDistUA * 0.2;
                  const fx = this.pos.x + offset * Math.cos(angle);
                  const fz = this.pos.z + offset * Math.sin(angle);
                  const fv = 0.3; // velocidad de dispersión en UA/año
                  const velx = fv * Math.cos(angle);
                  const velz = fv * Math.sin(angle);
                  bodies.push(new Cuerpo({
                    nombre: `Fragmento_${Date.now()}_${i}`,
                    masa: masaEach,
                    radioUA: this.radioUA / 3,
                    posicionUA: { x: fx, y: 0, z: fz },
                    velocidadUA: { x: velx, y: 0, z: velz },
                    color: 0xffffff,
                    tipo: 'meteorito'
                  }));
                }
                this._markeoParaEliminar = true;
              }
            }
          });
        }
      }
    }

    ///////////////////////////////////
    // 3. DIBUJAR ÓRBITA CIRCULAR (INCLINADA)
    ///////////////////////////////////
    function dibujarOrbita(radioDisplay, inclinDeg) {
      const inclinRad = THREE.Math.degToRad(inclinDeg);
      const segmentos = 256;
      const puntos = [];
      for (let i = 0; i <= segmentos; i++) {
        const theta = (i / segmentos) * Math.PI * 2;
        let x = Math.cos(theta) * radioDisplay;
        let z = Math.sin(theta) * radioDisplay;
        // Aplico inclinación rotando en X
        const y = z * Math.sin(inclinRad);
        const z2 = z * Math.cos(inclinRad);
        puntos.push(new THREE.Vector3(x, y, z2));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(puntos);
      const mat = new THREE.LineBasicMaterial({
        color: 0x555555,
        linewidth: 1,
        opacity: 0.6,
        transparent: true
      });
      const linea = new THREE.LineLoop(geo, mat);
      scene.add(linea);
      return linea;
    }

    ///////////////////////////////
    // 4. INICIALIZAR Three.js
    ///////////////////////////////
    function initThreeJS() {
      scene = new THREE.Scene();

      // Cargar fondo estrellado con textura inmersiva
      const loader = new THREE.TextureLoader();
      loader.load(
        'https://i.imgur.com/rpnwQpK.jpg', // fondo con nebulosas
        function(texture) {
          const bgGeo = new THREE.SphereGeometry(10000, 64, 64);
          const bgMat = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.BackSide
          });
          const bgMesh = new THREE.Mesh(bgGeo, bgMat);
          bgMesh.name = "backgroundSphere";
          scene.add(bgMesh);
        }
      );

      camera = new THREE.PerspectiveCamera(
        45,
        window.innerWidth / window.innerHeight,
        0.1,
        20000
      );
      camera.position.set(0, 500, 2000);
      camera.lookAt(new THREE.Vector3(0, 0, 0));

      // Ejes XYZ
      scene.add(axisHelper);

      // Luces
      const ambient = new THREE.AmbientLight(0x222222);
      scene.add(ambient);
      const point = new THREE.PointLight(0xffffff, 2.0, 0);
      point.position.set(0, 0, 0);
      scene.add(point);

      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(window.innerWidth, window.innerHeight);
      document.body.appendChild(renderer.domElement);

      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.1;
      controls.enablePan = true;
      controls.minDistance = 200;
      controls.maxDistance = 10000;

      raycaster = new THREE.Raycaster();

      window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });

      crearStarfield(); // estrellado con centelleos
    }

    //////////////////////////////////
    // 5. CREAR EL SOL, PLANETAS, LUNA y CINTURÓN
    //////////////////////////////////
    function initSolarSystem() {
      bodies.length = 0; 
      comets.length = 0;

      // Map de texturas para planetas y Luna
      const textureMap = {
        'Mercurio': 'https://threejsfundamentals.org/threejs/resources/images/mercury.jpg',
        'Venus':    'https://threejsfundamentals.org/threejs/resources/images/venus.jpg',
        'Tierra':   'https://threejs.org/examples/textures/earth_atmos_2048.jpg',
        'Marte':    'https://threejs.org/examples/textures/mars_1k_color.jpg',
        'Júpiter':  'https://threejs.org/examples/textures/jupiter2_1024.jpg',
        'Saturno':  'https://threejs.org/examples/textures/saturn.jpg',
        'Urano':    'https://threejs.org/examples/textures/uranus.jpg',
        'Neptuno':  'https://threejs.org/examples/textures/neptune.jpg',
        'Luna':     'https://threejs.org/examples/textures/moon_1024.jpg'
      };

      // 5.1. Sol
      const sol = new Cuerpo({
        nombre: 'Sol',
        masa: 1.0,
        radioUA: 0.00465,
        posicionUA: { x: 0, y: 0, z: 0 },
        velocidadUA: { x: 0, y: 0, z: 0 },
        color: 0xffee88,
        tipo: 'sol'
      });
      bodies.push(sol);
      agregarGlowAlSol();

      // 5.2. Planetas “oficiales”
      const datosPlanetas = [
        { nombre: 'Mercurio', masa: 1.660e-7, dist: 0.387, radio: 0.0000165, color: 0x909090 },
        { nombre: 'Venus',    masa: 2.447e-6, dist: 0.723, radio: 0.0000404, color: 0xffaa33 },
        { nombre: 'Tierra',   masa: 3.003e-6, dist: 1.000, radio: 0.0000426, color: 0x3366ff },
        { nombre: 'Marte',    masa: 3.227e-7, dist: 1.524, radio: 0.0000227, color: 0xff5533 },
        { nombre: 'Júpiter',  masa: 9.543e-4, dist: 5.204, radio: 0.0004779, color: 0xffbb88 },
        { nombre: 'Saturno',  masa: 2.857e-4, dist: 9.583, radio: 0.0004027, color: 0xffdd77, rings: true },
        { nombre: 'Urano',    masa: 4.370e-5, dist: 19.218, radio: 0.0001737, color: 0x66ddff },
        { nombre: 'Neptuno',  masa: 5.150e-5, dist: 30.110, radio: 0.0001659, color: 0x5577ff }
      ];
      datosPlanetas.forEach(dato => {
        const px = dato.dist, py = 0, pz = 0;
        const v = Math.sqrt(G * 1.0 / dato.dist);
        const vel = { x: 0, y: 0, z: v };

        const tex = textureMap[dato.nombre] || null;
        const planeta = new Cuerpo({
          nombre: dato.nombre,
          masa: dato.masa,
          radioUA: dato.radio,
          posicionUA: { x: px, y: py, z: pz },
          velocidadUA: vel,
          color: dato.color,
          tipo: 'planeta',
          hasRings: dato.rings || false,
          textureURL: tex
        });
        bodies.push(planeta);
      });

      // 5.3. Luna de la Tierra
      const earth = bodies.find(c => c.nombre === 'Tierra');
      if (earth) {
        const lunaMasa = 7.35e22 / 1.98847e30;
        const rUA = 0.00257;
        const px = earth.pos.x + rUA;
        const pz = earth.pos.z;
        const vLuna = 0.216;
        const vel = { x: earth.vel.x, y: 0, z: earth.vel.z + vLuna };
        const texLuna = textureMap['Luna'];
        const luna = new Cuerpo({
          nombre: 'Luna',
          masa: lunaMasa,
          radioUA: 0.0000117,
          posicionUA: { x: px, y: 0, z: pz },
          velocidadUA: vel,
          color: 0x8888ff,
          tipo: 'luna',
          textureURL: texLuna
        });
        bodies.push(luna);
      }

      // 5.4. Cinturón de asteroides (200 asteroides giratorios)
      const asteroideCount = 200;
      for (let i = 0; i < asteroideCount; i++) {
        const dist = 2.2 + 1.1 * Math.random();
        const angle = 2 * Math.PI * Math.random();
        const px = dist * Math.cos(angle);
        const pz = dist * Math.sin(angle);
        const v = Math.sqrt(G * 1.0 / dist);
        const massa = (1e15 + 1e17 * Math.random()) / 1.98847e30;
        const colorAst = 0xaaaaaa;
        const ast = new Cuerpo({
          nombre: `Asteroide_${i}`,
          masa: massa,
          radioUA: 0.000005 + 0.00001 * Math.random(),
          posicionUA: { x: px, y: 0, z: pz },
          velocidadUA: { x: -v * Math.sin(angle), y: 0, z: v * Math.cos(angle) },
          color: colorAst,
          tipo: 'asteroide',
          textureURL: 'https://threejs.org/examples/textures/planets/moon_1024.jpg'
        });
        bodies.push(ast);
      }
    }

    //////////////////////////
    // 6. ANIMACIÓN Y FÍSICA
    //////////////////////////
    function animate() {
      requestAnimationFrame(animate);

      if (simRunning) {
        bodies.forEach(c => c.actualizar(timeStep));
        simTime += timeStep;
        actualizarReloj();
      }

      detectarColisiones();

      let removed = false;
      for (let i = bodies.length - 1; i >= 0; i--) {
        if (bodies[i]._markeoParaEliminar) {
          scene.remove(bodies[i].mesh);
          scene.remove(bodies[i].trailLine);
          if (bodies[i].orbitLine) scene.remove(bodies[i].orbitLine);
          bodies.splice(i, 1);
          removed = true;
        }
      }
      if (removed) actualizarListaObjetos();

      if (simRunning) moverCometas();

      TWEEN.update();
      controls.update();
      actualizarScaleIndicator();
      actualizarMiniMap();
      aplicarLenteBH();
      renderer.render(scene, camera);
    }

    ////////////////////////////
    // 7. DETECCIÓN DE COLISIONES
    ////////////////////////////
    function detectarColisiones() {
      for (let i = bodies.length - 1; i >= 0; i--) {
        for (let j = i - 1; j >= 0; j--) {
          const A = bodies[i], B = bodies[j];
          if (A._markeoParaEliminar || B._markeoParaEliminar) continue;

          const dx = A.pos.x - B.pos.x;
          const dy = A.pos.y - B.pos.y;
          const dz = A.pos.z - B.pos.z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

          if (dist < (A.radioUA + B.radioUA)) {
            // Agujero Negro absorbe
            if (A.tipo === 'bn' && !B._markeoParaEliminar) {
              B._markeoParaEliminar = true;
              efectoColision(B);
              continue;
            }
            if (B.tipo === 'bn' && !A._markeoParaEliminar) {
              A._markeoParaEliminar = true;
              efectoColision(A);
              continue;
            }
            // Meteorito vs cualquiera → meteorito eliminado
            if (A.tipo === 'meteorito') {
              A._markeoParaEliminar = true;
              efectoColision(A);
              continue;
            }
            if (B.tipo === 'meteorito') {
              B._markeoParaEliminar = true;
              efectoColision(B);
              continue;
            }
            // Enana Blanca vs planeta/luna → otro eliminado
            if ((A.tipo === 'enanaBlanca' && (B.tipo === 'planeta' || B.tipo === 'planetaExtra' || B.tipo === 'luna'))) {
              B._markeoParaEliminar = true;
              efectoColision(B);
              continue;
            }
            if ((B.tipo === 'enanaBlanca' && (A.tipo === 'planeta' || A.tipo === 'planetaExtra' || A.tipo === 'luna'))) {
              A._markeoParaEliminar = true;
              efectoColision(A);
              continue;
            }
            // Estrella de Neutrones vs cualquiera → ambos eliminados
            if (A.tipo === 'ns' || B.tipo === 'ns') {
              A._markeoParaEliminar = true;
              B._markeoParaEliminar = true;
              efectoColision(A);
              efectoColision(B);
              continue;
            }
            // Fusión planeta <-> planetaExtra
            if ((A.tipo === 'planeta' || A.tipo === 'planetaExtra') &&
                (B.tipo === 'planeta' || B.tipo === 'planetaExtra')) {
              fusionarPlanetas(A, B);
              continue;
            }
          }
        }
      }
    }

    // Parpadeo en rojo antes de eliminar
    function efectoColision(c) {
      const originalColor = c.mesh.material.color.getHex();
      c.mesh.material.color.set(0xff0000);
      setTimeout(() => {
        if (c.mesh && c.mesh.material) c.mesh.material.color.set(originalColor);
      }, 200);
    }

    // Fusión de planetas/planetasExtras
    function fusionarPlanetas(A, B) {
      const masaTotal = A.masa + B.masa;
      const posFusion = {
        x: (A.pos.x * A.masa + B.pos.x * B.masa) / masaTotal,
        y: (A.pos.y * A.masa + B.pos.y * B.masa) / masaTotal,
        z: (A.pos.z * A.masa + B.pos.z * B.masa) / masaTotal
      };
      const velFusion = {
        x: (A.vel.x * A.masa + B.vel.x * B.masa) / masaTotal,
        y: (A.vel.y * A.masa + B.vel.y * B.masa) / masaTotal,
        z: (A.vel.z * A.masa + B.vel.z * B.masa) / masaTotal
      };
      const radioFusionUA = Math.cbrt(A.radioUA**3 + B.radioUA**3);
      const colorFusion = 0x88ff88;

      const fusionado = new Cuerpo({
        nombre: `Fusión_${Date.now()}`,
        masa: masaTotal,
        radioUA: radioFusionUA,
        posicionUA: posFusion,
        velocidadUA: velFusion,
        color: colorFusion,
        tipo: 'planetaExtra'
      });
      bodies.push(fusionado);
      A._markeoParaEliminar = true;
      B._markeoParaEliminar = true;
      actualizarListaObjetos();
    }

    ///////////////////////////////////////
    // 8. “TOUCH-TO-ADD” CUERPOS (addMode)
    ///////////////////////////////////////
    function onTouch(event) {
      event.preventDefault();
      if (!addMode) {
        // Modo selección: raycast para seleccionar cuerpo
        let x2, y2;
        if (event.changedTouches && event.changedTouches.length > 0) {
          x2 = event.changedTouches[0].clientX;
          y2 = event.changedTouches[0].clientY;
        } else {
          x2 = event.clientX;
          y2 = event.clientY;
        }
        touch.x = (x2 / window.innerWidth) * 2 - 1;
        touch.y = -((y2 / window.innerHeight) * 2 - 1);
        raycaster.setFromCamera(touch, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);
        if (intersects.length > 0) {
          const intersected = intersects[0].object;
          if (intersected.userData && intersected.userData.cuerpo) {
            const c = intersected.userData.cuerpo;
            enfocarObjeto(c);
            mostrarInfo(c);
          }
        }
        return;
      }

      // Modo Agregar: proyectar al plano Y=0 y abrir menú
      let x, y;
      if (event.changedTouches && event.changedTouches.length > 0) {
        x = event.changedTouches[0].clientX;
        y = event.changedTouches[0].clientY;
      } else {
        x = event.clientX;
        y = event.clientY;
      }
      touch.x = (x / window.innerWidth) * 2 - 1;
      touch.y = -((y / window.innerHeight) * 2 - 1);
      raycaster.setFromCamera(touch, camera);
      const intersectPoint = new THREE.Vector3();
      raycaster.ray.intersectPlane(planeY, intersectPoint);

      const tipo = prompt(
        '¿Qué quieres agregar?\n' +
        '1: Meteorito\n' +
        '2: Enana Blanca\n' +
        '3: Agujero Negro\n' +
        '4: Estrella de Neutrones\n' +
        '5: Planeta Extra\n' +
        '6: Cometa (Órbita extrema)\n',
        '1'
      );
      if (!tipo) return;
      const pxUA = intersectPoint.x / scaleDistance;
      const pzUA = intersectPoint.z / scaleDistance;
      switch (tipo.trim()) {
        case '1':
          crearMeteorito({ x: pxUA, z: pzUA });
          break;
        case '2':
          crearEnanaBlanca({ x: pxUA, z: pzUA });
          break;
        case '3':
          crearAgujeroNegro({ x: pxUA, z: pzUA });
          break;
        case '4':
          crearEstrellaNeutrones({ x: pxUA, z: pzUA });
          break;
        case '5':
          crearPlanetaExtra({ x: pxUA, z: pzUA });
          break;
        case '6':
          crearCometa({ x: pxUA, z: pzUA });
          break;
        default:
          alert('Opción inválida.');
      }
      actualizarListaObjetos();
    }

    ///////////////////////////////////////
    // 9. FUNCIONES PARA CREAR CADA TIPO
    ///////////////////////////////////////
    function crearMeteorito({ x, z }) {
      const masaKg = parseFloat(prompt('Masa del meteorito en kg (ej: 1e12):', '1e12'));
      if (isNaN(masaKg) || masaKg <= 0) return alert('Masa inválida.');
      const masaSolar = masaKg / 1.98847e30;

      const vcirc = Math.sqrt(G * 1.0 / Math.sqrt(x*x + z*z));
      const vx = parseFloat(prompt('Velocidad X (UA/año). Sugerencia: 0', '0'));
      const vz = parseFloat(prompt(`Velocidad Z (UA/año). Sugerencia: ${vcirc.toFixed(3)}`, vcirc.toFixed(3)));
      if (isNaN(vx) || isNaN(vz)) return alert('Velocidad inválida.');

      const radioUA = parseFloat(prompt('Radio en UA (ej: 1e-6):', '1e-6'));
      const nombre = `Meteorito_${Date.now()}`;
      bodies.push(new Cuerpo({
        nombre,
        masa: masaSolar,
        radioUA: isNaN(radioUA) ? 1e-6 : radioUA,
        posicionUA: { x, y: 0, z },
        velocidadUA: { x: vx, y: 0, z: vz },
        color: 0xffffff,
        tipo: 'meteorito'
      }));
    }

    function crearEnanaBlanca({ x, z }) {
      const masaSolar = parseFloat(prompt('Masa de la enana blanca en M⊙ (ej: 0.6):', '0.6'));
      if (isNaN(masaSolar) || masaSolar <= 0) return alert('Masa inválida.');

      const vx = parseFloat(prompt('Velocidad X (UA/año) (ej: 0):', '0'));
      const vz = parseFloat(prompt('Velocidad Z (UA/año) (ej: 0):', '0'));
      if (isNaN(vx) || isNaN(vz)) return alert('Velocidad inválida.');

      const radioUA = parseFloat(prompt('Radio en UA (sugerido ~1e-5):', '1e-5'));
      const nombre = `EnanaBlanca_${Date.now()}`;
      bodies.push(new Cuerpo({
        nombre,
        masa: masaSolar,
        radioUA: isNaN(radioUA) ? 1e-5 : radioUA,
        posicionUA: { x, y: 0, z },
        velocidadUA: { x: vx, y: 0, z: vz },
        color: 0xaaaaff,
        tipo: 'enanaBlanca'
      }));
    }

    function crearAgujeroNegro({ x, z }) {
      const masaSolar = parseFloat(prompt('Masa del agujero negro en M⊙ (ej: 10):', '10'));
      if (isNaN(masaSolar) || masaSolar <= 0) return alert('Masa inválida.');

      const vx = parseFloat(prompt('Velocidad X (UA/año) (ej: 0):', '0'));
      const vz = parseFloat(prompt('Velocidad Z (UA/año) (ej: 0):', '0'));
      if (isNaN(vx) || isNaN(vz)) return alert('Velocidad inválida.');

      const rschMeters = 2 * 6.67430e-11 * (masaSolar * 1.98847e30) / (299792458**2);
      const rschUA = rschMeters / 1.495978707e11;
      const nombre = `BH_${Date.now()}`;
      bodies.push(new Cuerpo({
        nombre,
        masa: masaSolar,
        radioUA: rschUA,
        posicionUA: { x, y: 0, z },
        velocidadUA: { x: vx, y: 0, z: vz },
        color: 0x000000,
        tipo: 'bn'
      }));
    }

    function crearEstrellaNeutrones({ x, z }) {
      const masaSolar = parseFloat(prompt('Masa de la estrella de neutrones en M⊙ (ej: 1.4):', '1.4'));
      if (isNaN(masaSolar) || masaSolar <= 0) return alert('Masa inválida.');

      const vx = parseFloat(prompt('Velocidad X (UA/año) (ej: 0):', '0'));
      const vz = parseFloat(prompt('Velocidad Z (UA/año) (ej: 0):', '0'));
      if (isNaN(vx) || isNaN(vz)) return alert('Velocidad inválida.');

      const radioMeters = 10e3;
      const radioUA = radioMeters / 1.495978707e11;
      const nombre = `NS_${Date.now()}`;
      bodies.push(new Cuerpo({
        nombre,
        masa: masaSolar,
        radioUA,
        posicionUA: { x, y: 0, z },
        velocidadUA: { x: vx, y: 0, z: vz },
        color: 0xff00ff,
        tipo: 'ns'
      }));
    }

    function crearPlanetaExtra({ x, z }) {
      const masaSolar = parseFloat(prompt('Masa del planeta en M⊙ (ej: 3e-6 para Tierra):', '3e-6'));
      if (isNaN(masaSolar) || masaSolar <= 0) return alert('Masa inválida.');

      const radioUA = parseFloat(prompt('Radio del planeta en UA (ej: 4.26e-5):', '4.26e-5'));
      if (isNaN(radioUA) || radioUA <= 0) return alert('Radio inválido.');

      const vx = parseFloat(prompt('Velocidad X (UA/año) (ej: 0):', '0'));
      const vz = parseFloat(prompt('Velocidad Z (UA/año) (ej: 0):', '0'));
      if (isNaN(vx) || isNaN(vz)) return alert('Velocidad inválida.');

      const nombre = `PlanetaExtra_${Date.now()}`;
      bodies.push(new Cuerpo({
        nombre,
        masa: masaSolar,
        radioUA,
        posicionUA: { x, y: 0, z },
        velocidadUA: { x: vx, y: 0, z: vz },
        color: 0x99ff99,
        tipo: 'planetaExtra'
      }));
    }

    function crearCometa({ x, z }) {
      const masaSolar = (1e13 + 5e13 * Math.random()) / 1.98847e30;
      const distInit = 55;  
      const angle = Math.random() * 2 * Math.PI;
      const px = distInit * Math.cos(angle);
      const pz = distInit * Math.sin(angle);
      const dirToSunX = -px / distInit;
      const dirToSunZ = -pz / distInit;
      const mag = 0.15 + 0.05 * Math.random();
      const vx = mag * dirToSunX;
      const vz = mag * dirToSunZ;
      const nombre = `Cometa_${Date.now()}`;
      const cometa = new Cuerpo({
        nombre,
        masa: masaSolar,
        radioUA: 0.00001,
        posicionUA: { x: px, y: 0, z: pz },
        velocidadUA: { x: vx, y: 0, z: vz },
        color: 0xff8822,
        tipo: 'cometa'
      });
      bodies.push(cometa);
      comets.push(cometa);
    }

    ///////////////////////////////////////////////
    // 10. MOVER COMETAS (Se eliminan si >80 UA o <0.1 UA)
    ///////////////////////////////////////////////
    let cometInterval = null;
    function iniciarCometasAleatorios() {
      cometInterval = setInterval(() => {
        const angle = Math.random() * 2 * Math.PI;
        const x = 55 * Math.cos(angle);
        const z = 55 * Math.sin(angle);
        crearCometa({ x, z });
        actualizarListaObjetos();
      }, 30000);
    }
    function moverCometas() {
      for (let i = comets.length - 1; i >= 0; i--) {
        const c = comets[i];
        const dist = Math.sqrt(c.pos.x*c.pos.x + c.pos.z*c.pos.z);
        if (dist > 80 || dist < 0.1) {
          c._markeoParaEliminar = true;
          comets.splice(i, 1);
        }
      }
    }
    function clearComets() {
      comets.forEach(c => c._markeoParaEliminar = true);
      comets.length = 0;
    }

    //////////////////////////////////////////
    // 11. CONTROL DEL SLIDER DE TIEMPO
    //////////////////////////////////////////
    function initTimeControl() {
      const slider = document.getElementById('timeSlider');
      const label = document.getElementById('timeLabel');
      slider.value = 10; 
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        timeStep = val * 0.0001; 
        if (timeStep < 1e-6 && simRunning) {
          simRunning = false;
          document.getElementById('playPauseBtn').textContent = 'Reanudar';
          document.getElementById('playPauseBtn').classList.remove('playing');
        }
        label.innerText = timeStep.toFixed(4) + ' años/frame';
      });
    }

    ////////////////////////////////////////
    // 12. ACTUALIZAR LA LISTA DE OBJETOS
    ////////////////////////////////////////
    function actualizarListaObjetos() {
      const ul = document.getElementById('objectList');
      ul.innerHTML = ''; 
      bodies.forEach(c => {
        const li = document.createElement('li');
        li.textContent = c.nombre;
        li.title = `Tipo: ${c.tipo}`;
        li.addEventListener('click', () => {
          enfocarObjeto(c);
          mostrarInfo(c);
        });
        ul.appendChild(li);
      });
    }

    ////////////////////////////////////////
    // 13. ENFOCAR CÁMARA EN UN OBJETO (Tween)
    ////////////////////////////////////////
    function enfocarObjeto(c) {
      const objPos = new THREE.Vector3(
        c.pos.x * scaleDistance,
        c.pos.y * scaleDistance,
        c.pos.z * scaleDistance
      );
      const offset = new THREE.Vector3(0, 2 * scaleDistance, 5 * scaleDistance);
      const nuevaCamPos = objPos.clone().add(offset);

      new TWEEN.Tween(camera.position)
        .to({ x: nuevaCamPos.x, y: nuevaCamPos.y, z: nuevaCamPos.z }, 800)
        .easing(TWEEN.Easing.Quadratic.Out)
        .start();
      new TWEEN.Tween(controls.target)
        .to({ x: objPos.x, y: objPos.y, z: objPos.z }, 800)
        .easing(TWEEN.Easing.Quadratic.Out)
        .start();
    }

    ////////////////////////////////////////
    // 14. MOSTRAR INFO DEL OBJETO SELECCIONADO
    ////////////////////////////////////////
    function mostrarInfo(c) {
      const panel = document.getElementById('infoPanel');
      document.getElementById('infoName').textContent = c.nombre;
      document.getElementById('infoType').textContent = `Tipo: ${c.tipo}`;

      const distUA = Math.sqrt(c.pos.x*c.pos.x + c.pos.z*c.pos.z).toFixed(4);
      document.getElementById('infoDist').textContent = `Dist. al Sol: ${distUA} UA`;

      const speedAUyr = Math.sqrt(c.vel.x*c.vel.x + c.vel.y*c.vel.y + c.vel.z*c.vel.z);
      const speedKms = (speedAUyr * 1.496e8 / 31557600).toFixed(2);
      document.getElementById('infoVel').textContent = `Vel: ${speedKms} km/s`;

      document.getElementById('infoMass').textContent = `Masa: ${c.masa.toExponential(2)} M⊙`;

      let orbitPeriodDays = '—';
      if (c.tipo === 'planeta' || c.tipo === 'luna' || c.tipo === 'planetaExtra') {
        const a = Math.sqrt(c.pos.x*c.pos.x + c.pos.z*c.pos.z);
        const Tyears = 2 * Math.PI * Math.sqrt(a*a*a / (G * 1.0));
        orbitPeriodDays = (Tyears * 365.2425).toFixed(1);
      }
      document.getElementById('infoOrbit').textContent = `Período Orbital: ${orbitPeriodDays} días`;

      let ecc = '—';
      if (orbitInclinations[c.nombre] !== undefined) {
        const excentricMap = {
          'Mercurio': 0.2056,
          'Venus':    0.0067,
          'Tierra':   0.0167,
          'Marte':    0.0934,
          'Júpiter':  0.0489,
          'Saturno':  0.0565,
          'Urano':    0.0464,
          'Neptuno':  0.0097,
          'Luna':     0.0549
        };
        ecc = excentricMap[c.nombre]?.toFixed(3) || '—';
      }
      document.getElementById('infoEcc').textContent = `Excentricidad: ${ecc}`;

      let temp = '—';
      const tempMap = {
        'Mercurio': 440,
        'Venus':    737,
        'Tierra':   288,
        'Marte':    210,
        'Júpiter':  165,
        'Saturno':  134,
        'Urano':    76,
        'Neptuno':  72,
        'Luna':     250
      };
      temp = tempMap[c.nombre] ? `${tempMap[c.nombre]} K` : '—';
      document.getElementById('infoTemp').textContent = `Temp. Superf.: ${temp}`;

      panel.style.display = 'block';
    }
    function ocultarInfo() {
      document.getElementById('infoPanel').style.display = 'none';
    }

    ////////////////////////////////////////
    // 15. MODO AGREGAR: toggle ON/OFF
    ////////////////////////////////////////
    function initModeButton() {
      const btn = document.getElementById('modeButton');
      btn.addEventListener('click', () => {
        addMode = !addMode;
        if (addMode) {
          btn.textContent = 'Modo Agregar: ON';
          btn.classList.add('active');
        } else {
          btn.textContent = 'Modo Agregar: OFF';
          btn.classList.remove('active');
        }
      });
    }

    //////////////////////////////////////////
    // 16. PLAY/PAUSE, RESET, ZOOM FIT, TOGGLE y CLEAR
    //////////////////////////////////////////
    function initExtraButtons() {
      const playBtn = document.getElementById('playPauseBtn');
      playBtn.addEventListener('click', () => {
        simRunning = !simRunning;
        if (simRunning) {
          playBtn.textContent = 'Pausa';
          playBtn.classList.add('playing');
        } else {
          playBtn.textContent = 'Reanudar';
          playBtn.classList.remove('playing');
          ocultarInfo();
        }
      });

      const orbitsBtn = document.getElementById('toggleOrbitsBtn');
      orbitsBtn.addEventListener('click', () => {
        showOrbits = !showOrbits;
        orbitsBtn.classList.toggle('active');
        orbitsBtn.textContent = showOrbits ? 'Ocultar Órbitas' : 'Mostrar Órbitas';
        bodies.forEach(c => {
          if (c.orbitLine) c.orbitLine.visible = showOrbits;
        });
      });

      const trailsBtn = document.getElementById('toggleTrailsBtn');
      trailsBtn.addEventListener('click', () => {
        showTrails = !showTrails;
        trailsBtn.classList.toggle('active');
        trailsBtn.textContent = showTrails ? 'Ocultar Trails' : 'Mostrar Trails';
        bodies.forEach(c => {
          if (c.trailLine) c.trailLine.visible = showTrails;
        });
      });

      const resetBtn = document.getElementById('resetBtn');
      resetBtn.addEventListener('click', () => {
        bodies.forEach(c => {
          scene.remove(c.mesh);
          scene.remove(c.trailLine);
          if (c.orbitLine) scene.remove(c.orbitLine);
        });
        bodies.length = 0;
        comets.length = 0;
        simTime = 0;
        actualizarReloj();
        ocultarInfo();
        initSolarSystem();
        actualizarListaObjetos();
      });

      const clearCometsBtn = document.getElementById('clearCometsBtn');
      clearCometsBtn.addEventListener('click', () => {
        clearComets();
      });

      const zoomFitBtn = document.getElementById('zoomFitBtn');
      zoomFitBtn.addEventListener('click', () => {
        zoomFitAll();
      });

      const screenshotBtn = document.getElementById('screenshotBtn');
      screenshotBtn.addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = renderer.domElement.toDataURL('image/png');
        link.download = 'screenshot.png';
        link.click();
      });
    }

    ////////////////////////////////////////////
    // 17. FUNCIÓN PARA CREAR STARFIELD con parpadeo
    ////////////////////////////////////////////
    function crearStarfield() {
      const cantidadEstrellas = 3000;
      const positions = new Float32Array(cantidadEstrellas * 3);
      const alphas = new Float32Array(cantidadEstrellas);
      for (let i = 0; i < cantidadEstrellas; i++) {
        const phi = Math.acos(2 * Math.random() - 1);
        const theta = 2 * Math.PI * Math.random();
        const r = 9000 * (0.9 + 0.1 * Math.random());
        const x = r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.sin(phi) * Math.sin(theta);
        const z = r * Math.cos(phi);
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        alphas[i] = 0.4 + 0.6 * Math.random();
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

      const material = new THREE.PointsMaterial({
        size: 2,
        color: 0xffffff,
        transparent: true,
        opacity: 1.0
      });

      const stars = new THREE.Points(geometry, material);
      scene.add(stars);

      setInterval(() => {
        const alphasArr = geometry.getAttribute('alpha').array;
        for (let i = 0; i < cantidadEstrellas; i++) {
          alphasArr[i] = 0.3 + 0.7 * Math.random();
        }
        geometry.getAttribute('alpha').needsUpdate = true;
      }, 300);

      material.onBeforeCompile = shader => {
        shader.vertexShader = `
          attribute float alpha;
          varying float vAlpha;
          ` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vAlpha = alpha;`
        );
        shader.fragmentShader = `
          varying float vAlpha;
          ` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          'gl_FragColor = vec4( outgoingLight, vAlpha );'
        );
      };
    }

    ///////////////////////////////////////////////
    // 18. FUNCIÓN PARA CREAR UN GLOW ALREDEDOR DEL SOL
    ///////////////////////////////////////////////
    function agregarGlowAlSol() {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createRadialGradient(
        size/2, size/2, 0, size/2, size/2, size/2
      );
      gradient.addColorStop(0, 'rgba(255,255,200,0.8)');
      gradient.addColorStop(0.2, 'rgba(255,255,150,0.6)');
      gradient.addColorStop(1, 'rgba(255,255,150,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);

      const texture = new THREE.CanvasTexture(canvas);
      const spriteMat = new THREE.SpriteMaterial({
        map: texture,
        blending: THREE.AdditiveBlending,
        transparent: true
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(1400, 1400, 1);
      sprite.position.set(0, 0, 0);
      scene.add(sprite);
    }

    ///////////////////////////////////////////
    // 19. ACTUALIZAR RELOJ SIMULADO (UI)
    ///////////////////////////////////////////
    function actualizarReloj() {
      const totalDays = simTime * 365.2425;
      const year = Math.floor(simTime);
      const dayOfYear = Math.floor(totalDays % 365.2425) + 1;
      const monthDays = [31, (year % 4 === 0 ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      let m = 0, day = dayOfYear;
      while (day > monthDays[m]) {
        day -= monthDays[m];
        m++;
      }
      const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      const monthStr = monthNames[m];
      const fracDay = totalDays - Math.floor(totalDays);
      const totalHours = fracDay * 24;
      const hour = Math.floor(totalHours);
      const minute = Math.floor((totalHours - hour) * 60);
      const clockStr = `${monthStr} ${day}, Año ${year} – ${(hour<10?'0':'')+hour}:${(minute<10?'0':'')+minute}`;
      document.getElementById('simClock').textContent = clockStr;
    }

    ///////////////////////////////////////////
    // 20. ZOOM FIT ALL: la cámara abarca todos los cuerpos
    ///////////////////////////////////////////
    function zoomFitAll() {
      if (bodies.length === 0) return;
      let minX=Infinity, maxX=-Infinity,
          minY=Infinity, maxY=-Infinity,
          minZ=Infinity, maxZ=-Infinity;
      bodies.forEach(c => {
        const x = c.pos.x * scaleDistance;
        const y = c.pos.y * scaleDistance;
        const z = c.pos.z * scaleDistance;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      });
      const dx = maxX - minX;
      const dy = maxY - minY;
      const dz = maxZ - minZ;
      const maxDim = Math.max(dx, dy, dz);
      const centerX = (maxX + minX) / 2;
      const centerY = (maxY + minY) / 2;
      const centerZ = (maxZ + minZ) / 2;
      const center = new THREE.Vector3(centerX, centerY, centerZ);
      const fov = camera.fov * (Math.PI/180);
      const desiredDist = (maxDim/2) / Math.tan(fov/2);
      const camDir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
      const newCamPos = center.clone().add(camDir.multiplyScalar(desiredDist * 1.2));

      new TWEEN.Tween(camera.position)
        .to({ x: newCamPos.x, y: newCamPos.y, z: newCamPos.z }, 800)
        .easing(TWEEN.Easing.Quadratic.Out)
        .start();
      new TWEEN.Tween(controls.target)
        .to({ x: center.x, y: center.y, z: center.z }, 800)
        .easing(TWEEN.Easing.Quadratic.Out)
        .start();
    }

    //////////////////////////////////////////
    // 21. INDICADOR DE ESCALA DINÁMICO (UI)
    //////////////////////////////////////////
    function actualizarScaleIndicator() {
      const p1 = new THREE.Vector3(0,0,0);
      const p2 = new THREE.Vector3(1 * scaleDistance, 0, 0);
      const v1 = p1.clone().project(camera);
      const v2 = p2.clone().project(camera);
      const dx = (v2.x - v1.x) * (window.innerWidth/2);
      const dy = (v2.y - v1.y) * (window.innerHeight/2);
      const distPx = Math.sqrt(dx*dx + dy*dy);
      const txt = `1 UA ≈ ${distPx.toFixed(1)} px`;
      document.getElementById('scaleIndicator').textContent = txt;
    }

    /////////////////////////////////////////////
    // 22. MINIMAP (HUD) – vista cenital 2D
    /////////////////////////////////////////////
    const miniCanvas = document.getElementById('miniMapCanvas');
    const miniCtx = miniCanvas.getContext('2d');
    function actualizarMiniMap() {
      const w = miniCanvas.width = miniCanvas.clientWidth;
      const h = miniCanvas.height = miniCanvas.clientHeight;
      miniCtx.fillStyle = 'rgba(0,0,0,0.6)';
      miniCtx.fillRect(0,0,w,h);

      const maxUA = 40 * scaleDistance;
      const center = { x: w/2, y: h/2 };

      bodies.forEach(c => {
        const x = c.pos.x * scaleDistance;
        const z = c.pos.z * scaleDistance;
        if (Math.abs(x) > maxUA || Math.abs(z) > maxUA) return;
        const px = center.x + (x / maxUA) * (w/2);
        const py = center.y + (z / maxUA) * (h/2);
        miniCtx.fillStyle = (c.seleccionado) ? '#ffdd55' : '#ffffff';
        miniCtx.beginPath();
        miniCtx.arc(px, py, 2, 0, Math.PI*2);
        miniCtx.fill();
      });
      // Indicador cámara
      const tgt = controls.target;
      const tx = tgt.x * scaleDistance;
      const tz = tgt.z * scaleDistance;
      if (Math.abs(tx) <= maxUA && Math.abs(tz) <= maxUA) {
        const px = center.x + (tx / maxUA) * (w/2);
        const py = center.y + (tz / maxUA) * (h/2);
        miniCtx.strokeStyle = '#ff0000';
        miniCtx.beginPath();
        miniCtx.arc(px, py, 5, 0, Math.PI*2);
        miniCtx.stroke();
      }
    }

    ///////////////////////////////////////////////
    // 23. SLIDER DE INCLINACIÓN DE ÓRBITAS (UI)
    ///////////////////////////////////////////////
    function initInclineControl() {
      const slider = document.getElementById('inclineRange');
      const label = document.getElementById('inclineValue');
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value); 
        label.textContent = `${val}°`;
        bodies.forEach(c => {
          if (c.orbitLine) {
            scene.remove(c.orbitLine);
            const radioDisplay = Math.max(c.radioUA * radiusScale, 0.3);
            c.orbitLine = dibujarOrbita(radioDisplay, val);
            c.orbitLine.visible = showOrbits;
          }
        });
      });
    }

    ///////////////////////////////////////////
    // 24. LENTE GRAVITATORIA SIMPLE PARA BH
    ///////////////////////////////////////////
    function aplicarLenteBH() {
      // Buscamos un BH activo
      const bh = bodies.find(c => c.tipo === 'bn');
      if (!bh) return;
      // Proyectar la posición del BH al espacio de la cámara
      const bhPos = new THREE.Vector3(bh.pos.x * scaleDistance, bh.pos.y * scaleDistance, bh.pos.z * scaleDistance);
      const screenPos = bhPos.clone().project(camera);
      // Si el BH está muy cerca del centro de la vista y la cámara está cerca (< 1000), aplicamos distorsión
      const distCam = camera.position.distanceTo(bhPos);
      if (distCam < 1000) {
        // Vamos a distorsionar el fondo: hallamos punto en pantalla
        const x = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
        const y = ( -screenPos.y * 0.5 + 0.5) * window.innerHeight;
        const radius = 150; // radio de distorsión en píxeles

        // Copiamos el área del fondo (solo las estrellas) y la ondulamos
        const bgCanvas = document.createElement('canvas');
        bgCanvas.width = window.innerWidth;
        bgCanvas.height = window.innerHeight;
        const bgCtx = bgCanvas.getContext('2d');
        bgCtx.drawImage(renderer.domElement, 0, 0);

        const imageData = bgCtx.getImageData(x - radius, y - radius, radius*2, radius*2);
        const data = imageData.data;
        // Distorsión radial muy simple: desplazamos píxeles hacia fuera
        for (let j = 0; j < radius*2; j++) {
          for (let i = 0; i < radius*2; i++) {
            const dx = i - radius;
            const dy = j - radius;
            const d2 = dx*dx + dy*dy;
            if (d2 < radius*radius) {
              const r = Math.sqrt(d2);
              const factor = 1 + 0.3 * ((radius - r) / radius);
              const srcX = Math.floor(radius + dx * factor);
              const srcY = Math.floor(radius + dy * factor);
              if (srcX >= 0 && srcX < radius*2 && srcY >= 0 && srcY < radius*2) {
                const dstIdx = (j * radius*2 + i) * 4;
                const srcIdx = (srcY * radius*2 + srcX) * 4;
                data[dstIdx]   = data[srcIdx];
                data[dstIdx+1] = data[srcIdx+1];
                data[dstIdx+2] = data[srcIdx+2];
                data[dstIdx+3] = data[srcIdx+3];
              }
            }
          }
        }
        // Pintamos la región distorsionada encima del lienzo principal
        const ctxMain = renderer.domElement.getContext('2d');
        ctxMain.putImageData(imageData, x - radius, y - radius);
      }
    }

    ///////////////////////////////////
    // 25. PUNTO DE ENTRADA (INIT Y EVENTOS)
    ///////////////////////////////////
    function main() {
      initThreeJS();
      initSolarSystem();
      initTimeControl();
      initModeButton();
      initExtraButtons();
      initInclineControl();
      actualizarListaObjetos();
      animate();
      iniciarCometasAleatorios();

      // Para manejar clics: si NO estamos en modo agregar, seleccionamos cuerpos
      renderer.domElement.addEventListener('pointerdown', onTouch, false);
    }

    main();
  };

