let THREE;
try {
  THREE = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js');
} catch (error) {
  const status = document.getElementById('sim3dStatus');
  if (status) { status.textContent = 'No se pudo cargar Three.js desde internet. Verifica la conexión y recarga el dashboard. La analítica 2D continúa disponible.'; status.className = 'sim3d-status warn'; }
  console.error('No se pudo cargar Three.js:', error);
  throw error;
}

(() => {
  const $ = id => document.getElementById(id);
  const DAY_MIN = 1440;
  const OPEN_MIN = 450;   // 07:30
  const CLOSE_MIN = 1110; // 18:30
  const DWELL_DEFAULT = 90;
  const WEEKDAYS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const fmt = new Intl.NumberFormat('es-PE');
  const fmtTime = m => {
    const n = Math.max(0, Math.min(1439, Math.round(m)));
    return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
  };
  const fmtDate = key => {
    if (!key) return '—';
    const [y,m,d] = key.split('-').map(Number);
    return new Date(y,m-1,d).toLocaleDateString('es-PE',{day:'2-digit',month:'short',year:'numeric'});
  };
  const svgToWorld = (x,y) => new THREE.Vector3(x-293, 0, 225-y);

  const outer = [
    [43,121],[319,52],[326,127],[373,126],[425,132],[477,146],[491,111],
    [570,140],[562,171],[538,231],[491,366],[451,350],[418,330],[388,322],
    [345,311],[305,309],[264,316],[205,329],[151,370],[79,398],[43,358],[17,269],[99,227]
  ];
  const zoneUpper = [[205,132],[478,145],[512,211],[490,225],[208,226],[183,185]];
  const zoneLower = [[151,236],[492,228],[492,360],[389,323],[264,317],[153,356]];
  const currentTables = [];
  const currentSeats = [];
  let renderer, scene, camera, root, currentFurniture, proposedFurniture, peopleGroup, ceilingGroup;
  let avatarMeshes = {};
  let initialized = false, raf = 0, chart = null, chartKey='';
  let records = [], selectedKey = '', activeLayout = 'actual', layoutCache = {};
  let currentSeatPositions = [], currentSeatRoutes = [];
  let simMinute = OPEN_MIN, peakStayMinutes = 90, offPeakStayMinutes = 45, speed = 1, playing = false;
  let peakWindow = {start: 600, end: 840, entries: 0};
  let drag = null, lastFrame = 0;
  let peakSummary = null, currentDayEvents = [];
  const MAX_AVATARS = 280;

  function setStatus(message, kind='') {
    const el = $('sim3dStatus');
    if (!el) return;
    el.textContent = message;
    el.className = `sim3d-status${kind ? ' '+kind : ''}`;
  }

  function makeShape(points, close=true) {
    const shape = new THREE.Shape();
    if (!points.length) return shape;
    shape.moveTo(points[0][0]-293, points[0][1]-225);
    for (let i=1;i<points.length;i++) shape.lineTo(points[i][0]-293, points[i][1]-225);
    if (close) shape.closePath();
    return shape;
  }

  function addFlatPolygon(parent, points, color, opacity=1, y=0.08, emissive=null) {
    const geo = new THREE.ShapeGeometry(makeShape(points), 1);
    geo.rotateX(-Math.PI/2);
    const mat = new THREE.MeshStandardMaterial({color, transparent:opacity<1, opacity, side:THREE.DoubleSide, roughness:.86, metalness:.02, emissive:emissive||0x000000, emissiveIntensity:.15});
    const mesh = new THREE.Mesh(geo,mat);
    mesh.position.y=y;
    mesh.receiveShadow=true;
    parent.add(mesh);
    return mesh;
  }

  function createWallSegment(parent, a, b, height=28, thickness=3.2, material=null, yBase=0) {
    const pa=svgToWorld(a[0],a[1]), pb=svgToWorld(b[0],b[1]);
    const dx=pb.x-pa.x, dz=pb.z-pa.z;
    const length=Math.sqrt(dx*dx+dz*dz);
    if (length<.01) return null;
    const geo=new THREE.BoxGeometry(length,height,thickness);
    const mat=material || new THREE.MeshStandardMaterial({color:0x71849c,roughness:.82,metalness:.08});
    const mesh=new THREE.Mesh(geo,mat);
    mesh.position.set((pa.x+pb.x)/2,yBase+height/2,(pa.z+pb.z)/2);
    mesh.rotation.y=-Math.atan2(dz,dx);
    mesh.castShadow=true; mesh.receiveShadow=true;
    parent.add(mesh);
    return mesh;
  }

  function addGlassSegment(parent,a,b,height=26) {
    const pa=svgToWorld(a[0],a[1]), pb=svgToWorld(b[0],b[1]);
    const dx=pb.x-pa.x,dz=pb.z-pa.z,length=Math.hypot(dx,dz);
    const angle=-Math.atan2(dz,dx);
    const glass=new THREE.Mesh(new THREE.BoxGeometry(length,height,1.1),new THREE.MeshPhysicalMaterial({color:0x8fd5ed,transparent:true,opacity:.27,roughness:.12,metalness:.12,side:THREE.DoubleSide,transmission:.15}));
    glass.position.set((pa.x+pb.x)/2,height/2+1,(pa.z+pb.z)/2);
    glass.rotation.y=angle; parent.add(glass);
    const frameMat=new THREE.MeshStandardMaterial({color:0x273d59,roughness:.55,metalness:.3});
    const count=Math.max(2,Math.floor(length/13));
    for(let i=0;i<=count;i++){
      const t=i/count, x=pa.x+dx*t,z=pa.z+dz*t;
      const mullion=new THREE.Mesh(new THREE.BoxGeometry(1.25,height+1,2),frameMat);
      mullion.position.set(x,height/2+1,z); parent.add(mullion);
    }
    const top=new THREE.Mesh(new THREE.BoxGeometry(length,1.5,2.3),frameMat);
    top.position.set((pa.x+pb.x)/2,height+1,(pa.z+pb.z)/2);top.rotation.y=angle;parent.add(top);
  }

  function createRoomWalls(parent, points, height=25, color=0x8392a7) {
    const mat=new THREE.MeshStandardMaterial({color,roughness:.88});
    for(let i=0;i<points.length;i++) createWallSegment(parent,points[i],points[(i+1)%points.length],height,2.7,mat);
  }

  function pointInPolygon(points,x,y) {
    let inside=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++){
      const xi=points[i][0], yi=points[i][1], xj=points[j][0], yj=points[j][1];
      const cross=((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi);
      if(cross) inside=!inside;
    }
    return inside;
  }

  function addFloorTileGrid(parent) {
    // Juntas de baldosa claras, limitadas al contorno del croquis.
    const stairPoly=[[17,269],[99,227],[147,314],[79,398],[43,358]];
    const verts=[];
    const minX=18,maxX=570,minY=52,maxY=398,step=14;
    const inside=(x,y)=>pointInPolygon(outer,x,y)&&!pointInPolygon(stairPoly,x,y);
    function addClippedLine(axis,fixed){
      let start=null,prev=null;
      const lo=axis==='h'?minX:minY, hi=axis==='h'?maxX:maxY;
      for(let v=lo;v<=hi+1;v+=1){
        const x=axis==='h'?v:fixed, y=axis==='h'?fixed:v;
        const ok=inside(x,y);
        if(ok&&!start) start=[x,y];
        if(!ok&&start){
          const end=prev;
          if(end){
            const a=svgToWorld(start[0],start[1]),b=svgToWorld(end[0],end[1]);
            verts.push(a.x,.24,a.z,b.x,.24,b.z);
          }
          start=null;
        }
        if(ok) prev=[x,y];
      }
      if(start&&prev){
        const a=svgToWorld(start[0],start[1]),b=svgToWorld(prev[0],prev[1]);
        verts.push(a.x,.24,a.z,b.x,.24,b.z);
      }
    }
    for(let y=minY+step;y<maxY;y+=step) addClippedLine('h',y);
    for(let x=minX+step;x<maxX;x+=step) addClippedLine('v',x);
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
    const mat=new THREE.LineBasicMaterial({color:0xb8b7ae,transparent:true,opacity:.42});
    const lines=new THREE.LineSegments(geo,mat);
    lines.renderOrder=2;parent.add(lines);
  }

  function bezierPoint(p0,p1,p2,p3,t){
    const u=1-t;
    return [
      u*u*u*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*p3[0],
      u*u*u*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*p3[1]
    ];
  }

  function createCurvedWindowWall(parent,curves,height=27,sill=5){
    const pts=[];
    curves.forEach((curve,ci)=>{
      const [p0,p1,p2,p3]=curve;
      const n=18;
      for(let i=0;i<=n;i++){
        if(ci>0&&i===0) continue;
        pts.push(bezierPoint(p0,p1,p2,p3,i/n));
      }
    });
    const frameMat=new THREE.MeshStandardMaterial({color:0x34404a,metalness:.48,roughness:.42});
    const glassMat=new THREE.MeshPhysicalMaterial({color:0xa8d7e8,transparent:true,opacity:.25,roughness:.16,metalness:.12,side:THREE.DoubleSide,transmission:.12});
    const paneH=height-sill-1.2;
    let distance=0,lastMullion=0;
    for(let i=0;i<pts.length-1;i++){
      const a=pts[i],b=pts[i+1],pa=svgToWorld(a[0],a[1]),pb=svgToWorld(b[0],b[1]);
      const dx=pb.x-pa.x,dz=pb.z-pa.z,len=Math.hypot(dx,dz);
      if(len<.1) continue;
      const angle=-Math.atan2(dz,dx);
      const pane=new THREE.Mesh(new THREE.BoxGeometry(len+.25,paneH,.65),glassMat);
      pane.position.set((pa.x+pb.x)/2,sill+paneH/2,(pa.z+pb.z)/2);
      pane.rotation.y=angle;pane.receiveShadow=true;parent.add(pane);
      distance+=len;
      if(distance-lastMullion>=13){
        const mullion=new THREE.Mesh(new THREE.BoxGeometry(1.05,paneH+1.1,1.35),frameMat);
        mullion.position.set(pb.x,sill+paneH/2,pb.z);parent.add(mullion);
        lastMullion=distance;
      }
    }
    const worldPts=pts.map(p=>{const q=svgToWorld(p[0],p[1]);return q;});
    for(const railY of [sill, height]){
      const railPts=worldPts.map(p=>new THREE.Vector3(p.x,railY,p.z));
      const curve=new THREE.CatmullRomCurve3(railPts);
      const rail=new THREE.Mesh(new THREE.TubeGeometry(curve,Math.max(40,pts.length*2),.8,6,false),frameMat);
      parent.add(rail);
    }
    // Peitoril contínuo claro na base do pano envidraçado.
    const sillPts=worldPts.map(p=>new THREE.Vector3(p.x,sill-1.8,p.z));
    const sillCurve=new THREE.CatmullRomCurve3(sillPts);
    const sillMesh=new THREE.Mesh(new THREE.TubeGeometry(sillCurve,Math.max(40,pts.length*2),1.15,6,false),new THREE.MeshStandardMaterial({color:0xe4e1d8,roughness:.8}));
    parent.add(sillMesh);
  }

  function createCeiling(parent){
    const group=new THREE.Group();
    const tileMat=new THREE.MeshStandardMaterial({color:0xf1f0e9,roughness:.92});
    const gridMat=new THREE.MeshStandardMaterial({color:0xb8bdc2,roughness:.8,metalness:.1});
    const lightMat=new THREE.MeshStandardMaterial({color:0xfff6df,emissive:0xffe8ad,emissiveIntensity:1.15,roughness:.28});
    const stairPoly=[[17,269],[99,227],[147,314],[79,398],[43,358]];
    let ix=0;
    for(let y=64;y<395;y+=14){
      let jx=0;
      for(let x=35;x<565;x+=14){
        if(!pointInPolygon(outer,x,y)||pointInPolygon(stairPoly,x,y)){jx++;continue;}
        const p=svgToWorld(x,y);
        const panel=new THREE.Mesh(new THREE.BoxGeometry(13.2,.55,13.2),tileMat);
        panel.position.set(p.x,31.8,p.z);group.add(panel);
        if((ix*3+jx)%8===0){
          const lamp=new THREE.Mesh(new THREE.BoxGeometry(8.8,.24,3.4),lightMat);
          lamp.position.set(p.x,32.25,p.z);group.add(lamp);
        }
        jx++;
      }
      ix++;
    }
    // Perfilería modular del cielo raso, como en las fotografías interiores.
    for(let y=70;y<395;y+=14){
      const spans=[];
      for(let x=35;x<565;x+=14){
        if(pointInPolygon(outer,x,y)&&!pointInPolygon(stairPoly,x,y)){
          const p=svgToWorld(x,y);
          spans.push([p.x,p.z]);
        }
      }
      for(let i=0;i<spans.length-1;i++){
        if(Math.abs(spans[i+1][0]-spans[i][0])<18){
          const line=new THREE.Mesh(new THREE.BoxGeometry(.35,.35,14),gridMat);
          line.position.set((spans[i][0]+spans[i+1][0])/2,31.6,(spans[i][1]+spans[i+1][1])/2);group.add(line);
        }
      }
    }
    group.visible=false;
    parent.add(group);
    return group;
  }

  function addTube(parent, points, color=0x35b88b, radius=1.05, y=.7) {
    const pts=points.map(([x,z])=>new THREE.Vector3(x,y,z));
    const curve=new THREE.CatmullRomCurve3(pts);
    const mesh=new THREE.Mesh(new THREE.TubeGeometry(curve,Math.max(24,points.length*9),radius,7,false),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.25,roughness:.5}));
    parent.add(mesh);return mesh;
  }

  function addColumn(parent,x,y,height=30) {
    const p=svgToWorld(x,y);
    const concrete=new THREE.MeshStandardMaterial({color:0xe9e7df,roughness:.88});
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(4.8,height,4.8),concrete);
    mesh.position.set(p.x,height/2,p.z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);
    const cap=new THREE.Mesh(new THREE.BoxGeometry(5.5,1.0,5.5),new THREE.MeshStandardMaterial({color:0xd0cec6,roughness:.85}));
    cap.position.set(p.x,height+.35,p.z);parent.add(cap);
  }

  function createStair(parent) {
    addFlatPolygon(parent,[[17,269],[99,227],[147,314],[79,398],[43,358]],0x6f7d8e,.55,.18);
    const stairMat=new THREE.MeshStandardMaterial({color:0xb2bdca,roughness:.8});
    const railMat=new THREE.MeshStandardMaterial({color:0x4c617a,metalness:.55,roughness:.35});
    // Tramos de peldaños esquemáticos dentro del polígono de escalera.
    const start=svgToWorld(34,279), end=svgToWorld(131,307);
    const dx=end.x-start.x,dz=end.z-start.z,len=Math.hypot(dx,dz),angle=-Math.atan2(dz,dx);
    for(let i=0;i<10;i++){
      const t=(i+.5)/10;
      const step=new THREE.Mesh(new THREE.BoxGeometry(len*.78,1.15,5.2),stairMat);
      step.position.set(start.x+dx*t,1.2+i*.15,start.z+dz*t);
      step.rotation.y=angle;parent.add(step);
    }
    const rail=new THREE.Mesh(new THREE.BoxGeometry(len*.86,.65,.65),railMat);
    rail.position.set((start.x+end.x)/2,10,(start.z+end.z)/2);rail.rotation.y=angle;parent.add(rail);
  }

  function createBookshelf(parent,x,y,rot=0) {
    const p=svgToWorld(x,y);const g=new THREE.Group();
    const bodyMat=new THREE.MeshStandardMaterial({color:0x8c6846,roughness:.78});
    const body=new THREE.Mesh(new THREE.BoxGeometry(13,17,4),bodyMat);body.position.y=8.5;g.add(body);
    for(let k=0;k<4;k++){
      const shelf=new THREE.Mesh(new THREE.BoxGeometry(13.4,.9,4.5),new THREE.MeshStandardMaterial({color:0xd4c5ad,roughness:.8}));
      shelf.position.set(0,3+k*4,0);g.add(shelf);
      for(let j=0;j<6;j++){
        const h=2.2+(j%3)*.6;
        const book=new THREE.Mesh(new THREE.BoxGeometry(1.25,h,2.8),new THREE.MeshStandardMaterial({color:[0x44a4b4,0xd6a04c,0x7292cf,0x5dba8b,0xb76b76][(j+k)%5]}));
        book.position.set(-5.4+j*2.15,3.4+k*4+h/2,0);g.add(book);
      }
    }
    g.position.set(p.x,0,p.z);g.rotation.y=rot;parent.add(g);
  }

  function createArchitecture() {
    // Piso y contorno: trazado vectorizado del croquis original (viewBox 0 0 590 430).
    const s=new THREE.Shape();
    s.moveTo(43-293,121-225);s.lineTo(319-293,52-225);s.lineTo(326-293,127-225);
    s.bezierCurveTo(373-293,126-225,425-293,132-225,477-293,146-225);
    s.lineTo(491-293,111-225);s.lineTo(570-293,140-225);s.lineTo(562-293,171-225);s.lineTo(538-293,231-225);s.lineTo(491-293,366-225);
    s.bezierCurveTo(451-293,350-225,418-293,330-225,388-293,322-225);
    s.bezierCurveTo(345-293,311-225,305-293,309-225,264-293,316-225);
    s.bezierCurveTo(205-293,329-225,151-293,370-225,79-293,398-225);
    s.lineTo(43-293,358-225);s.lineTo(17-293,269-225);s.lineTo(99-293,227-225);s.closePath();
    const floorGeo=new THREE.ShapeGeometry(s,3);floorGeo.rotateX(-Math.PI/2);
    const floor=new THREE.Mesh(floorGeo,new THREE.MeshStandardMaterial({color:0xd8d6ce,roughness:.94,metalness:.01,side:THREE.DoubleSide}));
    floor.position.y=0;floor.receiveShadow=true;root.add(floor);
    addFloorTileGrid(root);

    // Zonas del croquis, con tintes suaves para mantener la lectura espacial.
    addFlatPolygon(root,zoneUpper,0x9cc8a9,.16,.13);
    addFlatPolygon(root,zoneLower,0x9ab9d6,.15,.14);

    // Muros interiores y perímetro: tonos claros observados en las fotografías.
    const wallMat=new THREE.MeshStandardMaterial({color:0xe8e6df,roughness:.9,metalness:.01});
    const auxMat=new THREE.MeshStandardMaterial({color:0xeeeae2,roughness:.9});
    // Segmentos rectos del contorno original. Las curvas se modelan como ventanales.
    for(let i=0;i<outer.length;i++){
      const j=(i+1)%outer.length;
      const isLowerCurvedFacade=(i>=10&&i<=18);
      const isUpperCurvedFacade=(i>=2&&i<=4);
      if(isLowerCurvedFacade||isUpperCurvedFacade) continue;
      createWallSegment(root,outer[i],outer[j],27,3.0,wallMat);
    }

    // Ventanales curvos de perfilería oscura, respetando las dos curvas del croquis.
    createCurvedWindowWall(root,[
      [[326,127],[373,126],[425,132],[477,146]]
    ],26,5.5);
    createCurvedWindowWall(root,[
      [[491,366],[451,350],[418,330],[388,322]],
      [[388,322],[345,311],[305,309],[264,316]],
      [[264,316],[205,329],[151,370],[79,398]]
    ],27,5.2);

    // Ambientes auxiliares, tabiques y acceso lateral según el plano.
    createRoomWalls(root,[[44,121],[160,91],[173,173],[142,205],[96,226]],25,0xe8e6df);
    createRoomWalls(root,[[162,91],[231,72],[238,128],[326,127],[322,52]],25,0xe8e6df);
    createRoomWalls(root,[[491,111],[570,140],[562,171],[478,146]],24,0xe8e6df);

    // Escalera: mantiene su ubicación, forma y sentido de circulación del croquis.
    createRoomWalls(root,[[17,269],[99,227],[147,314],[79,398],[43,358]],8,0xd0d0c9);
    createStair(root);

    // Columnas claras de concreto, como las observadas en el interior.
    [[243.5,219.5],[327.5,216.5],[415.5,224.5],[471.5,247.5],[289.5,307.5]].forEach(([x,y])=>addColumn(root,x,y,30));

    // Estanterías discretas en ambientes auxiliares; no invaden las dos zonas de estudio.
    createBookshelf(root,105,177,-.35);
    createBookshelf(root,204,89,.12);
    createBookshelf(root,528,151,.35);

    // Banda de circulación central y rutas de evacuación trazadas en el croquis.
    addTube(root,[[128,224],[198,224],[264,223],[334,223],[397,224],[455,224],[505,224]].map(([x,y])=>{const p=svgToWorld(x,y);return [p.x,p.z]}),0x35ad83,2.15,.36);
    const greenRoutes=[[[321,126],[321,175],[321,212]],[[132,158],[150,190],[163,215],[178,268]],[[218,92],[220,151],[225,212]],[[519,168],[512,205],[505,221],[491,286]]];
    greenRoutes.forEach(route=>addTube(root,route.map(([x,y])=>{const p=svgToWorld(x,y);return[p.x,p.z]}),0x249d75,.72,.5));
    const redRoutes=[[[337,108],[380,109],[423,115],[466,124]],[[58,282],[45,300],[55,340],[80,358],[100,350],[141,330]]];
    redRoutes.forEach(route=>addTube(root,route.map(([x,y])=>{const p=svgToWorld(x,y);return[p.x,p.z]}),0xd65d58,.62,.55));

    // Suelo exterior oscuro, que enmarca el modelo sin alterar el plano.
    const grid=new THREE.GridHelper(760,44,0x2a4469,0x1a2f4c);grid.position.y=-1.1;root.add(grid);

    // Cielo raso modular de placas claras y luminarias LED. Se activa con un botón,
    // porque la vista principal es abierta para poder observar las mesas y los avatares.
    ceilingGroup=createCeiling(root);
  }

  function addTable(parent,x,y,kind='existing',w=17,h=9) {
    const p=svgToWorld(x+w/2,y+h/2);
    const g=new THREE.Group();
    const isNew=kind==='new';
    const topMat=new THREE.MeshStandardMaterial({color:isNew?0xe59a32:0x14588f,roughness:.52,metalness:.04});
    const top=new THREE.Mesh(new THREE.BoxGeometry(w,1.2,h),topMat);top.position.y=8.2;top.castShadow=true;top.receiveShadow=true;g.add(top);
    const edge=new THREE.Mesh(new THREE.BoxGeometry(w+.55,.55,h+.55),new THREE.MeshStandardMaterial({color:isNew?0x9d5d14:0x102f4d,roughness:.58,metalness:.18}));edge.position.y=7.55;g.add(edge);
    const legMat=new THREE.MeshStandardMaterial({color:0x202a33,metalness:.38,roughness:.48});
    for(const sx of [-1,1])for(const sz of [-1,1]){
      const leg=new THREE.Mesh(new THREE.BoxGeometry(.72,7.4,.72),legMat);leg.position.set(sx*(w/2-1.2),3.7,sz*(h/2-1));g.add(leg);
      const foot=new THREE.Mesh(new THREE.BoxGeometry(1.25,.45,1.25),legMat);foot.position.set(sx*(w/2-1.2),.25,sz*(h/2-1));g.add(foot);
    }
    g.position.set(p.x,0,p.z);parent.add(g);
    return g;
  }

  function addChair(parent,x,y,kind='existing',w=4.5,h=4.1,targetSvg=null) {
    const p=svgToWorld(x,y);
    let yaw=0;
    if(targetSvg && Number.isFinite(targetSvg.x) && Number.isFinite(targetSvg.y)){
      const target=svgToWorld(targetSvg.x,targetSvg.y);
      yaw=Math.atan2(target.x-p.x,target.z-p.z);
    }
    const g=new THREE.Group();
    const isNew=kind==='new';
    const seatMat=new THREE.MeshStandardMaterial({color:isNew?0x27a579:0x17618f,roughness:.7});
    const backMat=new THREE.MeshStandardMaterial({color:isNew?0x16835f:0x24394d,roughness:.74});
    const frameMat=new THREE.MeshStandardMaterial({color:0x20272d,metalness:.34,roughness:.52});
    const seat=new THREE.Mesh(new THREE.BoxGeometry(w,.9,h),seatMat);seat.position.y=3.0;seat.castShadow=true;g.add(seat);
    const back=new THREE.Mesh(new THREE.BoxGeometry(w,.9,.85),backMat);back.position.set(0,5.4,h*.43);back.castShadow=true;g.add(back);
    for(const sx of [-1,1]){
      const post=new THREE.Mesh(new THREE.BoxGeometry(.48,3.6,.48),frameMat);post.position.set(sx*(w*.39),4.25,h*.43);g.add(post);
      for(const sz of [-1,1]){
        const leg=new THREE.Mesh(new THREE.BoxGeometry(.48,2.8,.48),frameMat);leg.position.set(sx*(w*.38),1.35,sz*(h*.36));g.add(leg);
      }
    }
    g.position.set(p.x,0,p.z);g.rotation.y=yaw;parent.add(g);
    return {x:p.x,z:p.z,kind,yaw};
  }

  function addSofa(parent,x,y,seatPositions) {
    const p=svgToWorld(x+15,y+6.5);const g=new THREE.Group();
    const baseMat=new THREE.MeshStandardMaterial({color:0x805b4d,roughness:.88});
    const cushionMat=new THREE.MeshStandardMaterial({color:0xa47d6b,roughness:.9});
    const base=new THREE.Mesh(new THREE.BoxGeometry(30,3.2,13),baseMat);base.position.y=2.2;g.add(base);
    const back=new THREE.Mesh(new THREE.BoxGeometry(30,8,2.8),baseMat);back.position.set(0,7.5,5.0);g.add(back);
    for(let i=0;i<2;i++){
      const cushion=new THREE.Mesh(new THREE.BoxGeometry(13.3,1.4,8.5),cushionMat);cushion.position.set(-7.2+i*14.4,4,0);g.add(cushion);
      seatPositions.push({x:p.x-7.2+i*14.4,z:p.z,kind:'sofa',yaw:Math.PI});
    }
    for(const sx of [-1,1]){
      const arm=new THREE.Mesh(new THREE.BoxGeometry(2.6,6.5,13),baseMat);arm.position.set(sx*14,4.5,0);g.add(arm);
    }
    g.position.set(p.x,0,p.z);parent.add(g);
  }

  function makeWalkRoute(seat){
    const seatSvgX=seat.x+293;
    const seatSvgY=225-seat.z;
    const laneX=Math.max(164,Math.min(505,seatSvgX));
    const raw=[[107,337],[126,319],[143,294],[157,267],[164,242],[166,224],[laneX,224],[seatSvgX,seatSvgY]];
    const clean=[];
    raw.forEach(pt=>{const prev=clean[clean.length-1];if(!prev||Math.hypot(pt[0]-prev[0],pt[1]-prev[1])>2)clean.push(pt);});
    const pts=clean.map(([x,y])=>{const p=svgToWorld(x,y);return new THREE.Vector3(p.x,.8,p.z);});
    const curve=new THREE.CatmullRomCurve3(pts,false,'centripetal',.25);
    const length=curve.getLength();
    // La escala del SVG no está calibrada en metros: la duración es visual/de simulación.
    const duration=Math.max(6.5,Math.min(11.5,length/42));
    return {curve,duration,length};
  }

  function buildCurrentFurniture() {
    currentFurniture=new THREE.Group();root.add(currentFurniture);
    const positions=[];const upperXs=[245,293,341,389,437],upperYs=[145,161,177,193];
    const lowerXs=[260,291,322,353,384,415,446],lowerYs=[243,260,277,294];
    const addRow=(xs,ys)=>ys.forEach(y=>xs.forEach(x=>{
      addTable(currentFurniture,x,y,'existing');
      [[x+3,y-3],[x+14,y-3],[x+3,y+12],[x+14,y+12]].forEach(([cx,cy])=>positions.push(addChair(currentFurniture,cx,cy,'existing',4.5,4.1,{x:x+8.5,y:y+4.5})));
    }));
    addRow(upperXs,upperYs);addRow(lowerXs,lowerYs);
    positions.push(addChair(currentFurniture,475,301,'existing',4.5,4.1,{x:468,y:294}));
    // Cuatro sofás de dos plazas según la ubicación aproximada del croquis/fotografías.
    const sofas=[[188,274],[222,274],[188,291],[222,291]];
    sofas.forEach(([x,y])=>addSofa(currentFurniture,x,y,positions));
    currentSeatPositions=positions;
    currentSeatRoutes=positions.map(makeWalkRoute);
    currentFurniture.visible=true;
  }

  function buildPlemFurniture(result) {
    const group=new THREE.Group();
    const seats=[];
    (result.ubicaciones||[]).forEach((p)=>{
      const mesa=p.mesa_svg||{};
      const x=Number(mesa.x),y=Number(mesa.y),w=Number(mesa.ancho),h=Number(mesa.alto);
      if([x,y,w,h].every(Number.isFinite))addTable(group,x,y,p.tipo==='adicional'?'new':'existing',w,h);
      (p.sillas_svg||[]).forEach(s=>{
        const sx=Number(s.x),sy=Number(s.y),sw=Number(s.ancho),sh=Number(s.alto);
        const kind=(seats.filter(v=>v.kind==='existing').length < Number(result.sillas_existentes_utilizadas||193))?'existing':'new';
        const centerX=sx+sw/2,centerY=sy+sh/2;
        seats.push(addChair(group,centerX-2,centerY-2,kind,Math.max(3.4,sw*.72),Math.max(3.4,sh*.72),{x:Number(mesa.x)+Number(mesa.ancho)/2,y:Number(mesa.y)+Number(mesa.alto)/2}));
      });
    });
    const sofaCount=Number(result.sofas_conservados??result.sofas??4);
    const sofaPlaces=[];const sofas=[[188,274],[222,274],[188,291],[222,291]];
    sofas.slice(0,sofaCount).forEach(([x,y])=>addSofa(group,x,y,sofaPlaces));
    seats.push(...sofaPlaces);
    return {group,seats,routes:seats.map(makeWalkRoute)};
  }

  function createAvatars() {
    const clothGeo=new THREE.CapsuleGeometry(.82,3.35,4,8);
    const headGeo=new THREE.SphereGeometry(1.08,12,10);
    const hairGeo=new THREE.SphereGeometry(1.12,10,7);
    const armGeo=new THREE.CapsuleGeometry(.29,1.55,3,7);
    const legGeo=new THREE.CapsuleGeometry(.36,1.75,3,7);
    const shoeGeo=new THREE.BoxGeometry(.9,.58,1.55);
    const inst=(geo,rough=.78)=>{
      const mesh=new THREE.InstancedMesh(geo,new THREE.MeshStandardMaterial({color:0xffffff,roughness:rough,metalness:.01}),MAX_AVATARS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;peopleGroup.add(mesh);return mesh;
    };
    peopleGroup=new THREE.Group();root.add(peopleGroup);
    avatarMeshes={
      torso:inst(clothGeo,.82),head:inst(headGeo,.82),hair:inst(hairGeo,.9),
      armL:inst(armGeo,.82),armR:inst(armGeo,.82),legL:inst(legGeo,.86),legR:inst(legGeo,.86),
      shoeL:inst(shoeGeo,.78),shoeR:inst(shoeGeo,.78)
    };
    Object.values(avatarMeshes).forEach(m=>m.count=0);
  }

  function initScene() {
    if (initialized) return;
    const canvas=$('crai3dCanvas');
    if (!canvas) return;
    scene=new THREE.Scene();scene.background=new THREE.Color(0x08152c);scene.fog=new THREE.Fog(0x08152c,470,1120);
    camera=new THREE.PerspectiveCamera(43,1,.1,1800);
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.65));
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
    scene.add(new THREE.HemisphereLight(0xfff6e8,0x48556a,2.45));
    const key=new THREE.DirectionalLight(0xfff4df,2.65);key.position.set(-170,260,180);scene.add(key);
    const fill=new THREE.DirectionalLight(0x86c4ff,1.2);fill.position.set(160,140,-180);scene.add(fill);
    const rim=new THREE.PointLight(0x57a8ff,1.5,700);rim.position.set(0,120,220);scene.add(rim);
    root=new THREE.Group();scene.add(root);
    createArchitecture();buildCurrentFurniture();createAvatars();
    setCamera('iso');resize();
    canvas.addEventListener('pointerdown',onPointerDown);canvas.addEventListener('pointermove',onPointerMove);canvas.addEventListener('pointerup',onPointerUp);canvas.addEventListener('pointercancel',onPointerUp);canvas.addEventListener('wheel',onWheel,{passive:false});canvas.addEventListener('contextmenu',e=>e.preventDefault());
    window.addEventListener('resize',resize);
    if (window.ResizeObserver) { const ro=new ResizeObserver(resize); ro.observe(canvas.parentElement); }
    initialized=true;
    if(!raf)raf=requestAnimationFrame(animate);
  }

  let cameraTarget=new THREE.Vector3(0,0,0),camYaw=-.72,camPitch=.68,camRadius=500;
  function setCamera(view) {
    if(!camera)return;
    if(view==='top'){camYaw=0;camPitch=1.52;camRadius=510;}
    else if(view==='interior'){camYaw=-.05;camPitch=.42;camRadius=430;}
    else{camYaw=-.72;camPitch=.68;camRadius=500;}
    updateCamera();
  }
  function updateCamera(){
    const cp=Math.max(.14,Math.min(1.54,camPitch));
    camera.position.set(cameraTarget.x+camRadius*Math.sin(camYaw)*Math.cos(cp),cameraTarget.y+camRadius*Math.sin(cp),cameraTarget.z+camRadius*Math.cos(camYaw)*Math.cos(cp));
    camera.lookAt(cameraTarget);
  }
  function resize(){
    if(!renderer||!camera)return;
    const canvas=$('crai3dCanvas'),w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);
    renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
  }
  function onPointerDown(e){drag={x:e.clientX,y:e.clientY,button:e.button, yaw:camYaw,pitch:camPitch,target:cameraTarget.clone()};$('crai3dCanvas').setPointerCapture(e.pointerId);}
  function onPointerMove(e){
    if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(drag.button===2){cameraTarget.x=drag.target.x-dx*.35;cameraTarget.z=drag.target.z+dy*.35;}
    else{camYaw=drag.yaw-dx*.006;camPitch=drag.pitch+dy*.005;}
    updateCamera();
  }
  function onPointerUp(){drag=null;}
  function onWheel(e){e.preventDefault();camRadius=Math.max(250,Math.min(800,camRadius+e.deltaY*.45));updateCamera();}
  function animate(t){
    raf=requestAnimationFrame(animate);
    if(playing&&lastFrame){const delta=Math.min(80,t-lastFrame);simMinute+=delta/1000*2*speed;if(simMinute>=CLOSE_MIN){simMinute=CLOSE_MIN;playing=false;updatePlayButton();}updateTimelineFromPlayback();}
    lastFrame=t;
    if(renderer&&scene&&camera)renderer.render(scene,camera);
  }

  function groupByDate(input){const m=new Map();input.forEach(r=>{if(!m.has(r.key))m.set(r.key,[]);m.get(r.key).push(r);});for(const arr of m.values())arr.sort((a,b)=>a.minuteOfDay-b.minuteOfDay);return m;}
  function analyze(input){
    peakWindow=getPeakWindow(input);
    const grouped=groupByDate(input);const daily=[];
    grouped.forEach((events,key)=>{const p=maxRolling(events);daily.push({key,weekday:events[0]?.weekday??new Date(key+'T00:00:00').getDay(),max:p.max,time:p.time,entries:events.length,events});});
    daily.sort((a,b)=>a.key.localeCompare(b.key));
    const peak=[...daily].sort((a,b)=>b.max-a.max||a.key.localeCompare(b.key))[0]||null;
    const weekdaySummary=new Map(),weekdayEntries=new Map();daily.forEach(d=>{const o=weekdaySummary.get(d.weekday)||{sum:0,count:0,max:0};o.sum+=d.max;o.count++;o.max=Math.max(o.max,d.max);weekdaySummary.set(d.weekday,o);const e=weekdayEntries.get(d.weekday)||{sum:0,count:0};e.sum+=d.entries;e.count++;weekdayEntries.set(d.weekday,e);});
    const topWeek=[...weekdaySummary.entries()].sort((a,b)=>(b[1].sum/b[1].count)-(a[1].sum/a[1].count))[0]||null;
    const topEntryWeek=[...weekdayEntries.entries()].sort((a,b)=>(b[1].sum/b[1].count)-(a[1].sum/a[1].count))[0]||null;
    const byHour=new Array(24).fill(0);input.forEach(r=>byHour[Math.floor(r.minuteOfDay/60)]++);
    const peakEntryHour=byHour.indexOf(Math.max(...byHour));
    return {daily,peak,topWeek,topEntryWeek,byHour,peakEntryHour,grouped,peakWindow};
  }

  function fillDateSelectors(info){
    const dateEl=$('sim3dDate'),weekdayEl=$('sim3dWeekday');if(!dateEl||!weekdayEl)return;
    const oldKey=selectedKey;const weekdayOld=weekdayEl.value;
    const days=info.daily;
    dateEl.innerHTML='';
    days.forEach(d=>{const op=document.createElement('option');op.value=d.key;op.textContent=`${fmtDate(d.key)} · ${d.max} pico estimado`;dateEl.appendChild(op);});
    weekdayEl.innerHTML='<option value="">Todos los días</option>';
    [1,2,3,4,5,6,0].forEach(w=>{if(days.some(d=>d.weekday===w)){const op=document.createElement('option');op.value=String(w);op.textContent=WEEKDAYS[w];weekdayEl.appendChild(op);}});
    if([...weekdayEl.options].some(o=>o.value===weekdayOld))weekdayEl.value=weekdayOld;
    let choice=days.find(d=>d.key===oldKey&&(!weekdayEl.value||String(d.weekday)===weekdayEl.value));
    if(!choice){const candidates=days.filter(d=>!weekdayEl.value||String(d.weekday)===weekdayEl.value);choice=[...candidates].sort((a,b)=>b.max-a.max)[0]||days[0];}
    if(choice){selectedKey=choice.key;dateEl.value=choice.key;}
    dateEl.disabled=!days.length;weekdayEl.disabled=!days.length;
  }

  function eventsForSelectedDay(){return records.filter(r=>r.key===selectedKey).sort((a,b)=>a.minuteOfDay-b.minuteOfDay);}

  function getPeakWindow(input){
    const counts=new Array(24).fill(0);
    input.forEach(r=>{const h=Math.floor(Number(r.minuteOfDay)/60);if(h>=0&&h<24)counts[h]++;});
    const first=Math.floor(OPEN_MIN/60),last=Math.floor(CLOSE_MIN/60)-3;
    let bestStart=first,bestTotal=-1;
    for(let h=first;h<=last;h++){
      const total=counts.slice(h,h+4).reduce((a,b)=>a+b,0);
      if(total>bestTotal){bestTotal=total;bestStart=h;}
    }
    return {start:bestStart*60,end:(bestStart+4)*60,entries:Math.max(0,bestTotal)};
  }

  function isPeakArrival(record){return Number(record.minuteOfDay)>=peakWindow.start&&Number(record.minuteOfDay)<peakWindow.end;}
  function dwellForRecord(record){return isPeakArrival(record)?peakStayMinutes:offPeakStayMinutes;}

  function maxRolling(events){
    const timeline=[];
    events.forEach(ev=>{
      const start=Number(ev.minuteOfDay),end=start+dwellForRecord(ev);
      timeline.push({t:start,delta:1});timeline.push({t:end,delta:-1});
    });
    timeline.sort((a,b)=>a.t-b.t||a.delta-b.delta); // primero salen, luego entran: intervalo [entrada, salida)
    let current=0,best=0,bestTime=null;
    for(const e of timeline){current+=e.delta;if(e.delta>0&&current>best){best=current;bestTime=e.t;}}
    return {max:best,time:bestTime};
  }

  function seatSimulation(events,time,seatPositions,capacity,routes=[]){
    const cap=Math.min(capacity,seatPositions.length);const active=[];const unserved=[];const free=[];for(let i=0;i<cap;i++)free.push(i);
    for(const ev of events){
      if(ev.minuteOfDay>time)break;
      for(let i=active.length-1;i>=0;i--){if(active[i].departure<=ev.minuteOfDay){free.push(active[i].seatIndex);active.splice(i,1);}}
      for(let i=unserved.length-1;i>=0;i--){if(unserved[i].departure<=ev.minuteOfDay)unserved.splice(i,1);}
      free.sort((a,b)=>a-b);
      const dwell=dwellForRecord(ev);
      if(free.length){
        const seatIndex=free.shift();
        active.push({record:ev,arrival:ev.minuteOfDay,seatIndex,departure:ev.minuteOfDay+dwell,dwellMinutes:dwell,route:routes[seatIndex]||null});
      } else unserved.push({record:ev,departure:ev.minuteOfDay+dwell,dwellMinutes:dwell});
    }
    const inside=active.filter(a=>a.departure>time);
    const excess=unserved.filter(a=>a.departure>time);
    const concurrent=events.filter(e=>e.minuteOfDay<=time&&e.minuteOfDay+dwellForRecord(e)>time).length;
    return {inside,excess,concurrent,capacity:cap};
  }

  function easeWalk(t){const x=Math.max(0,Math.min(1,t));return x*x*(3-2*x);}
  function setPart(mesh,index,dummy,pos,yaw,scale,color,rotX=0,rotZ=0){
    if(!mesh)return;
    dummy.position.set(pos.x,pos.y,pos.z);dummy.rotation.set(rotX,yaw,rotZ);dummy.scale.set(scale[0],scale[1],scale[2]);dummy.updateMatrix();
    mesh.setMatrixAt(index,dummy.matrix);if(color!==undefined)mesh.setColorAt(index,new THREE.Color(color));
  }
  function localPoint(base,x,y,z,yaw){
    const c=Math.cos(yaw),s=Math.sin(yaw);
    return {x:base.x+x*c+z*s,y,z:base.z-x*s+z*c};
  }
  function avatarPalette(record,index){
    const key=String(record.code||`${record.key}-${record.minuteOfDay}-${index}`);let hash=0;
    for(let i=0;i<key.length;i++)hash=(hash*31+key.charCodeAt(i))|0;
    const clothing=[0x3f8fbc,0x367a68,0x4d5f9b,0x9b7049,0x7c5f91,0xb16a62,0x546d7e,0x9b9d51];
    const skin=[0xd9aa86,0xc9916d,0xe5b998,0xb97e5e,0xeac8a7];
    const hair=[0x252a31,0x3a2d28,0x4b3b32,0x1e2632];
    const n=Math.abs(hash);
    return {clothes:clothing[n%clothing.length],skin:skin[(n>>>3)%skin.length],hair:hair[(n>>>6)%hair.length]};
  }

  function drawPersonInstances(active,seatPositions,time){
    if(!avatarMeshes.torso)return;
    const names=Object.keys(avatarMeshes);names.forEach(k=>{avatarMeshes[k].count=0;});
    const dummy=new THREE.Object3D();
    active=active.slice(0,MAX_AVATARS);
    active.forEach((a,i)=>{
      const seat=seatPositions[a.seatIndex]||seatPositions[i]||{x:0,z:0,yaw:0};
      const age=Math.max(0,time-a.arrival),remain=Math.max(0,a.departure-time);
      const route=a.route;const walkIn=route?.duration||3.5;const walkOut=Math.min(walkIn,a.dwellMinutes*.2);
      let pose='sit',base={x:seat.x,y:0,z:seat.z},yaw=Number(seat.yaw)||0,phase=0;
      if(route&&age<walkIn){
        pose='walk';const u=easeWalk(age/walkIn);base=route.curve.getPointAt(u);const tangent=route.curve.getTangentAt(Math.min(.999,Math.max(.001,u)));yaw=Math.atan2(tangent.x,tangent.z);phase=age*1.55;
      }else if(route&&remain<walkOut){
        pose='walk';const u=easeWalk(remain/walkOut);base=route.curve.getPointAt(u);const tangent=route.curve.getTangentAt(Math.min(.999,Math.max(.001,u)));yaw=Math.atan2(-tangent.x,-tangent.z);phase=(a.dwellMinutes-remain)*1.55;
      }else{
        const subtle=Math.sin((time*.22)+i*.7)*.035;
        base={x:seat.x,y:subtle,z:seat.z};phase=0;
      }
      const pal=avatarPalette(a.record,i);const walking=pose==='walk';
      const bob=walking?Math.abs(Math.sin(phase))*0.28:Math.sin(time*.18+i)*.06;
      const torso=localPoint(base,0,walking?5.0+bob:4.75,0,yaw);
      const head=localPoint(base,0,walking?8.65+bob:8.15+bob,0,yaw);
      const hair=localPoint(base,0,walking?9.45+bob:8.88+bob,-.05,yaw);
      setPart(avatarMeshes.torso,i,dummy,torso,yaw,[1,1,1],pal.clothes,walking?Math.sin(phase)*.045:.12,walking?Math.sin(phase*.5)*.035:0);
      setPart(avatarMeshes.head,i,dummy,head,yaw,[.92,.98,.92],pal.skin,0,0);
      setPart(avatarMeshes.hair,i,dummy,hair,yaw,[1,.55,1],pal.hair,.1,0);
      const armSwing=walking?Math.sin(phase)*.62:0;
      const leftArm=localPoint(base,walking?-1.18:-1.08,walking?5.15:4.75,walking?.04:1.05,yaw);
      const rightArm=localPoint(base,walking?1.18:1.08,walking?5.15:4.75,walking?.04:1.05,yaw);
      setPart(avatarMeshes.armL,i,dummy,leftArm,yaw,[1,1,1],pal.skin,walking?armSwing:-.72,walking?-.13:.08);
      setPart(avatarMeshes.armR,i,dummy,rightArm,yaw,[1,1,1],pal.skin,walking?-armSwing:-.72,walking?.13:-.08);
      const legSwing=walking?Math.sin(phase)*.56:0;
      const leftLeg=localPoint(base,-.48,walking?2.05:1.7,walking?0:1.2,yaw);
      const rightLeg=localPoint(base,.48,walking?2.05:1.7,walking?0:1.2,yaw);
      setPart(avatarMeshes.legL,i,dummy,leftLeg,yaw,[1,1,1],0x253342,walking?legSwing:1.12,0);
      setPart(avatarMeshes.legR,i,dummy,rightLeg,yaw,[1,1,1],0x253342,walking?-legSwing:1.12,0);
      const leftShoe=localPoint(base,-.48,.42,walking?.18:2.0,yaw);
      const rightShoe=localPoint(base,.48,.42,walking?-.18:2.0,yaw);
      setPart(avatarMeshes.shoeL,i,dummy,leftShoe,yaw,[1,1,1],0x20252b,0,0);
      setPart(avatarMeshes.shoeR,i,dummy,rightShoe,yaw,[1,1,1],0x20252b,0,0);
    });
    Object.values(avatarMeshes).forEach(mesh=>{mesh.count=active.length;mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;});
  }

  function updateChart(events,capacity,seatCount){
    const labels=[],demand=[],inside=[],excess=[];
    const fakeSeats=Array.from({length:Math.min(capacity,seatCount)},(_,i)=>({x:0,z:0}));
    for(let m=OPEN_MIN;m<=CLOSE_MIN;m+=5){
      labels.push(fmtTime(m));
      const sim=seatSimulation(events,m,fakeSeats,capacity);
      demand.push(sim.concurrent);inside.push(sim.inside.length);excess.push(sim.excess.length);
    }
    if(typeof Chart==='undefined'||!$('sim3dOccupancyChart'))return;
    if(chart){chart.data.labels=labels;chart.data.datasets[0].data=demand;chart.data.datasets[1].data=inside;chart.data.datasets[2].data=excess;chart.update('none');return;}
    const ctx=$('sim3dOccupancyChart');
    chart=new Chart(ctx,{type:'line',data:{labels,datasets:[
      {label:'Demanda simultánea estimada',data:demand,borderColor:'#54b9ed',backgroundColor:'rgba(84,185,237,.10)',fill:true,tension:.28,borderWidth:2,pointRadius:0},
      {label:'Estudiantes asignados',data:inside,borderColor:'#35bd92',backgroundColor:'transparent',tension:.25,borderWidth:2,pointRadius:0},
      {label:'Demanda no atendida',data:excess,borderColor:'#e16c76',backgroundColor:'transparent',tension:.25,borderWidth:1.7,pointRadius:0}
    ]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{labels:{color:'#bdcde2',boxWidth:8,font:{size:8}}},tooltip:{mode:'index',intersect:false}},scales:{x:{ticks:{color:'#9fb4cf',font:{size:7},maxTicksLimit:7},grid:{display:false}},y:{beginAtZero:true,ticks:{color:'#9fb4cf',font:{size:8}},grid:{color:'rgba(160,184,214,.12)'}}}}});
  }

  const SHARED_SIM_KEY = 'CRAI_SIM_CONCURRENCY_STATE_V1';
  let lastPublishedSnapshotKey = '';
  let lastPublishedAt = 0;
  function publishConcurrencySnapshot(day, sim, capacity) {
    if (!selectedKey || !Array.isArray(day)) return;
    const roundedMinute = Math.round(simMinute);
    const snapshotKey = `${selectedKey}|${roundedMinute}|${activeLayout}|${offPeakStayMinutes}|${peakStayMinutes}`;
    const now = Date.now();
    if (snapshotKey === lastPublishedSnapshotKey && now - lastPublishedAt < 900) return;
    if (now - lastPublishedAt < 280 && snapshotKey !== lastPublishedSnapshotKey) return;
    const payload = {
      version: 1,
      date: selectedKey,
      minute: roundedMinute,
      peakStart: Number(peakWindow.start),
      peakEnd: Number(peakWindow.end),
      peakStayMinutes: Number(peakStayMinutes),
      offPeakStayMinutes: Number(offPeakStayMinutes),
      demand: Number(sim.concurrent || 0),
      assigned: Number(sim.inside?.length || 0),
      excess: Number(sim.excess?.length || 0),
      capacity: Number(capacity || 0),
      sourceLayout: activeLayout,
      speed: Number(speed) || 1,
      playing: Boolean(playing),
      events: day.map(ev => [Number(ev.minuteOfDay), String(ev.code || ev.id || '')]),
      updatedAt: now
    };
    try {
      localStorage.setItem(SHARED_SIM_KEY, JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent('crai:concurrency-state', { detail: payload }));
      lastPublishedSnapshotKey = snapshotKey;
      lastPublishedAt = now;
    } catch (error) {
      console.warn('No se pudo compartir el estado de concurrencia con las vistas 3D:', error);
    }
  }

  function updateSimulation(){
    if(!records.length||!initialized)return;
    const day=eventsForSelectedDay();currentDayEvents=day;
    const layout=layoutCache[activeLayout]||layoutCache.actual;
    const seatPositions=layout?.seats||currentSeatPositions;
    const routes=layout?.routes||currentSeatRoutes;
    const capacity=layout?.capacity||201;
    const sim=seatSimulation(day,simMinute,seatPositions,capacity,routes);
    publishConcurrencySnapshot(day, sim, capacity);
    drawPersonInstances(sim.inside,seatPositions,simMinute);
    const entering=sim.inside.filter(a=>simMinute-a.arrival<(a.route?.duration||3.5)).length;
    const leaving=sim.inside.filter(a=>a.departure-simMinute<Math.min(a.route?.duration||3.5,a.dwellMinutes*.2)).length;
    $('sim3dInside').textContent=fmt.format(sim.inside.length);
    $('sim3dInsideSub').textContent=`${entering} caminando hacia sus plazas · ${leaving} saliendo`;
    $('sim3dCapacity').textContent=fmt.format(capacity);
    $('sim3dCapacitySub').textContent=activeLayout==='actual'?'Mobiliario actual contabilizado':'Capacidad de la alternativa PLEM';
    $('sim3dDemand').textContent=fmt.format(sim.concurrent);
    $('sim3dUnserved').textContent=fmt.format(sim.excess.length);
    $('sim3dPercent').textContent=`${capacity?Math.min(100,sim.inside.length/capacity*100).toFixed(1):0}%`;
    $('sim3dDepartures').textContent=fmt.format(leaving);
    $('sim3dTimeLabel').textContent=fmtTime(simMinute);$('sim3dTimeChip').textContent=fmtTime(simMinute);
    $('sim3dDateChip').textContent=fmtDate(selectedKey);
    $('sim3dModeChip').textContent=activeLayout==='actual'?'CRAI actual':`Propuesta PLEM ${activeLayout}`;
    $('sim3dTime').value=Math.round(simMinute);
    const peak=peakSummary?.daily?.find(d=>d.key===selectedKey);
    $('sim3dPeakHour').textContent=peak&&peak.time!=null?fmtTime(peak.time):'—';
    const hourCounts=new Array(24).fill(0);day.forEach(r=>hourCounts[Math.floor(r.minuteOfDay/60)]++);const dayEntryHour=hourCounts.indexOf(Math.max(...hourCounts));$('sim3dArrivalPeak').textContent=hourCounts[dayEntryHour]?`${String(dayEntryHour).padStart(2,'0')}:00`: '—';
    const occText=sim.concurrent>capacity?`A las ${fmtTime(simMinute)} la demanda simultánea estimada supera la capacidad en ${sim.concurrent-capacity} estudiantes. El modelo asigna plazas hasta el aforo y contabiliza el excedente como demanda no atendida estimada.`:`A las ${fmtTime(simMinute)} la demanda simultánea estimada es ${sim.concurrent} de ${capacity} plazas. Las salidas simuladas liberan asientos y permiten atender nuevos ingresos.`;
    $('sim3dInterpretation').textContent=occText;
    const nextChartKey=`${selectedKey}|${peakWindow.start}|${offPeakStayMinutes}|${capacity}|${activeLayout}`;
    if(chartKey!==nextChartKey){updateChart(day,capacity,seatPositions.length);chartKey=nextChartKey;}
  }

  function updateTimelineFromPlayback(){
    $('sim3dTime').value=Math.min(CLOSE_MIN,Math.round(simMinute));
    updateSimulation();
  }
  function updatePlayButton(){const b=$('sim3dPlay');if(b)b.textContent=playing?'Ⅱ Pausar':'▶ Reproducir';}

  function refreshPeakLabels(){
    if(!peakSummary)return;
    const peak=peakSummary.peak;
    $('sim3dPeakDate').textContent=peak?fmtDate(peak.key):'—';
    $('sim3dPeakValue').textContent=peak?`${fmt.format(peak.max)} · ${fmtTime(peak.time)}`:'—';
    $('sim3dPeakWeekday').textContent=peakSummary.topWeek?`${WEEKDAYS[peakSummary.topWeek[0]]} · ${(peakSummary.topWeek[1].sum/peakSummary.topWeek[1].count).toFixed(1)} pico`:'—';
    $('sim3dPeakWeekdayEntries').textContent=peakSummary.topEntryWeek?`${WEEKDAYS[peakSummary.topEntryWeek[0]]} · ${(peakSummary.topEntryWeek[1].sum/peakSummary.topEntryWeek[1].count).toFixed(1)} ingresos/día`:'—';
    const peakLabel=`${fmtTime(peakWindow.start)}–${fmtTime(peakWindow.end)} · ${peakStayMinutes} min`;
    if($('sim3dPeakWindow'))$('sim3dPeakWindow').textContent=peakLabel;
    if($('sim3dOffPeakStayLabel'))$('sim3dOffPeakStayLabel').textContent=`${offPeakStayMinutes} min`;
    if(peak)$('sim3dLoadPeak').disabled=false;
  }

  function updateAnalytics(){
    if(!records.length)return;
    peakSummary=analyze(records);
    refreshPeakLabels();
    return peakSummary;
  }

  function setRecords(newRecords){
    if(!Array.isArray(newRecords))return;
    records=newRecords.filter(r=>Number.isFinite(Number(r.minuteOfDay))&&r.key).map(r=>({...r,minuteOfDay:Number(r.minuteOfDay)}));
    if(!records.length){selectedKey='';$('sim3dInside').textContent='—';$('sim3dDemand').textContent='—';$('sim3dUnserved').textContent='—';$('sim3dPeakDate').textContent='—';setStatus('No hay registros con fecha y hora exactas dentro de los filtros actuales.');return;}
    records.sort((a,b)=>a.key.localeCompare(b.key)||a.minuteOfDay-b.minuteOfDay);
    const info=analyze(records);peakSummary=info;fillDateSelectors(info);refreshPeakLabels();
    const hourly=info.byHour;const peakHour=hourly.indexOf(Math.max(...hourly));
    const peak=info.peak;
    $('sim3dPeakDate').textContent=peak?fmtDate(peak.key):'—';$('sim3dPeakValue').textContent=peak?`${fmt.format(peak.max)} · ${fmtTime(peak.time)}`:'—';
    $('sim3dPeakWeekday').textContent=info.topWeek?`${WEEKDAYS[info.topWeek[0]]} · ${(info.topWeek[1].sum/info.topWeek[1].count).toFixed(1)}`:'—';
    $('sim3dPeakHour').textContent=`${String(peakHour).padStart(2,'0')}:00 · ${fmt.format(hourly[peakHour])} ingresos`;
    $('sim3dTime').disabled=false;$('sim3dPlay').disabled=false;$('sim3dReset').disabled=false;$('sim3dLoadPeak').disabled=!peak;$('sim3dGoPeak').disabled=false;
    if(!selectedKey&&peak)selectedKey=peak.key;
    const datePeak=info.daily.find(d=>d.key===selectedKey)||info.daily[0];
    if(datePeak){$('sim3dDate').value=datePeak.key;simMinute=Math.max(OPEN_MIN,Math.min(CLOSE_MIN,Math.round(datePeak.time??OPEN_MIN)));}
    initScene();resize();chartKey='';
    setStatus(`${fmt.format(records.length)} registros válidos. Ventana pico detectada: ${fmtTime(peakWindow.start)}–${fmtTime(peakWindow.end)}; permanencia de ${peakStayMinutes} min en pico y ${offPeakStayMinutes} min fuera de pico. ${layoutCache.A ? 'Modelos 3D PLEM A/B/C disponibles.' : 'Para activar los escenarios 3D, guarda una comparación completa exacta A/B/C desde CBC.'}`, 'ok');
    updateSimulation();
  }

  async function loadPlemExactResults(){
    try{
      const res=await fetch('/api/plem/resultados',{cache:'no-store'});
      if(!res.ok)return;
      const payload=await res.json();
      if(!payload.disponible||!payload.comparacion_completa_exacta||!payload.datos?.resultados)return;
      for(const code of ['A','B','C']){
        const result=payload.datos.resultados.find(r=>r.codigo===code);
        if(!result||!Array.isArray(result.ubicaciones))continue;
        const built=buildPlemFurniture(result);root.add(built.group);built.group.visible=false;
        layoutCache[code]={group:built.group,seats:built.seats,routes:built.routes,capacity:Number(result.capacidad_total_propuesta||result.estudiantes_atendidos||built.seats.length),result};
        const op=$('sim3dCapacityMode').querySelector(`option[value="${code}"]`);if(op)op.disabled=false;
      }
      setStatus(`Tres modelos 3D PLEM cargados: A (${layoutCache.A?.seats.length||0} plazas), B (${layoutCache.B?.seats.length||0}) y C (${layoutCache.C?.seats.length||0}). Puedes alternar entre CRAI actual y cada escenario.`, 'ok');
      updateSimulation();
    }catch(err){console.info('Los resultados PLEM A/B/C no se pudieron cargar para la simulación 3D:',err);}
  }

  function setLayout(code){
    const next=code==='actual'?'actual':code;
    if(next!=='actual'&&!layoutCache[next]){setStatus(`No se encontró la distribución espacial exacta del escenario ${next}. Ejecuta y guarda la comparación completa A/B/C en CBC.`, 'warn');$('sim3dCapacityMode').value=activeLayout;return;}
    if(currentFurniture)currentFurniture.visible=next==='actual';
    ['A','B','C'].forEach(k=>{if(layoutCache[k]?.group)layoutCache[k].group.visible=next===k;});
    activeLayout=next;
    updateSimulation();
  }

  function bindControls(){
    $('sim3dDate')?.addEventListener('change',e=>{selectedKey=e.target.value;const d=peakSummary?.daily?.find(x=>x.key===selectedKey);simMinute=Math.max(OPEN_MIN,Math.min(CLOSE_MIN,Math.round(d?.time??OPEN_MIN)));updateSimulation();});
    $('sim3dWeekday')?.addEventListener('change',e=>{
      const w=e.target.value;const candidates=(peakSummary?.daily||[]).filter(d=>!w||String(d.weekday)===w);
      const best=[...candidates].sort((a,b)=>b.max-a.max)[0];if(best){selectedKey=best.key;$('sim3dDate').value=best.key;simMinute=Math.max(OPEN_MIN,Math.min(CLOSE_MIN,Math.round(best.time??OPEN_MIN)));updateSimulation();}
    });
    $('sim3dTime')?.addEventListener('input',e=>{playing=false;updatePlayButton();simMinute=Number(e.target.value);updateSimulation();});
    $('sim3dOffPeakStay')?.addEventListener('input',e=>{offPeakStayMinutes=Number(e.target.value);$('sim3dOffPeakStayLabel').textContent=`${offPeakStayMinutes} min`;updateAnalytics();refreshPeakLabels();updateSimulation();});
    $('sim3dSpeed')?.addEventListener('change',e=>{speed=Number(e.target.value)||1;});
    $('sim3dView')?.addEventListener('change',e=>setCamera(e.target.value));
    $('sim3dCeiling')?.addEventListener('click',()=>{
      if(!ceilingGroup)return;
      ceilingGroup.visible=!ceilingGroup.visible;
      $('sim3dCeiling').textContent=ceilingGroup.visible?'Ocultar techo':'Mostrar techo';
      setStatus(ceilingGroup.visible?'Cielo raso modular y luminarias activados para la vista interior.':'Vista abierta activada para observar la distribución y los estudiantes virtuales.','ok');
    });
    $('sim3dCapacityMode')?.addEventListener('change',e=>setLayout(e.target.value));
    $('sim3dPlay')?.addEventListener('click',()=>{if(!records.length)return;if(simMinute>=CLOSE_MIN)simMinute=OPEN_MIN;playing=!playing;lastFrame=0;updatePlayButton();});
    $('sim3dReset')?.addEventListener('click',()=>{playing=false;simMinute=OPEN_MIN;updatePlayButton();updateSimulation();});
    $('sim3dLoadPeak')?.addEventListener('click',()=>{if(!peakSummary?.peak)return;selectedKey=peakSummary.peak.key;$('sim3dDate').value=selectedKey;simMinute=Math.max(OPEN_MIN,Math.min(CLOSE_MIN,Math.round(peakSummary.peak.time??OPEN_MIN)));updateSimulation();});
    $('sim3dGoPeak')?.addEventListener('click',()=>{const d=peakSummary?.daily?.find(x=>x.key===selectedKey);if(d?.time!=null){simMinute=Math.max(OPEN_MIN,Math.min(CLOSE_MIN,Math.round(d.time)));updateSimulation();}});
    const go=()=>{const sec=$('simulation3D');sec?.scrollIntoView({behavior:'smooth',block:'start'});};
    $('goSimulation3D')?.addEventListener('click',go);$('moduleSimulation3D')?.addEventListener('click',go);
  }

  function start(){
    bindControls();
    // Construir el 3D solo cuando el navegador tenga el contenedor de la página principal.
    try{initScene();setStatus('Modelo 3D listo. Carga el Excel para iniciar la simulación de concurrencia.');loadPlemExactResults();}
    catch(err){console.error(err);setStatus('No se pudo inicializar Three.js. Comprueba la conexión a internet y recarga el dashboard. Detalle: '+err.message,'warn');}
  }

  window.CRAI3D={setRecords,start};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  if(Array.isArray(window.__CRAI_PENDING_RECORDS) && window.__CRAI_PENDING_RECORDS.length) setRecords(window.__CRAI_PENDING_RECORDS);
})();
