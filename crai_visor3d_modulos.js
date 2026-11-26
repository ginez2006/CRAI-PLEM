/* CRAI · Visor 3D compartido para comparación, propuesta y CBC.
   La planta reproduce el croquis vectorizado en unidades SVG; no constituye escala arquitectónica. */
(async () => {
  let THREE, OrbitControls;
  try {
    try { THREE = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'); }
    catch (firstError) { THREE = await import('https://unpkg.com/three@0.160.0/build/three.module.js'); }
    try { ({ OrbitControls } = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js')); }
    catch (firstError) { ({ OrbitControls } = await import('https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js')); }
  } catch (error) {
    console.error('CRAI 3D: no se pudo cargar Three.js u OrbitControls.', error);
    document.querySelectorAll('[data-crai3d-view]').forEach(host => {
      host.innerHTML = '<div class="crai3d-empty"><strong>No se pudo cargar la vista 3D.</strong><br>Verifica que crai_visor3d_modulos.js esté en D:\\yhon y que haya conexión a Internet para descargar Three.js. Después actualiza con Ctrl + F5.</div>';
    });
    return;
  }
  const NS = 'http://www.w3.org/2000/svg';
  const OUTER = [[43,121],[319,52],[326,127],[373,126],[425,132],[477,146],[491,111],[570,140],[562,171],[538,231],[491,366],[451,350],[418,330],[388,322],[345,311],[305,309],[264,316],[205,329],[151,370],[79,398],[43,358],[17,269],[99,227]];
  const UPPER = [[205,132],[478,145],[512,211],[490,225],[208,226],[183,185]];
  const LOWER = [[151,236],[492,228],[492,360],[389,323],[264,317],[153,356]];
  const STAIR = [[17,269],[99,227],[147,314],[79,398],[43,358]];
  const $ = id => document.getElementById(id);
  const world = (x,y) => new THREE.Vector3(Number(x)-293, 0, 225-Number(y));
  const fmt = new Intl.NumberFormat('es-PE');
  let dataCache = null;
  const viewers = new Map();

  function shapeFromPoints(points) {
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0]-293, points[0][1]-225);
    for (let i=1;i<points.length;i++) shape.lineTo(points[i][0]-293, points[i][1]-225);
    shape.closePath();
    return shape;
  }
  function flatPolygon(parent, points, color, opacity=1, y=.08) {
    const geo = new THREE.ShapeGeometry(shapeFromPoints(points), 2); geo.rotateX(-Math.PI/2);
    const mat = new THREE.MeshStandardMaterial({color, transparent:opacity<1, opacity, side:THREE.DoubleSide, roughness:.88});
    const mesh = new THREE.Mesh(geo, mat); mesh.position.y=y; mesh.receiveShadow=true; parent.add(mesh); return mesh;
  }
  function wall(parent,a,b,height=25,thickness=2.8,color=0xe8e6df) {
    const pa=world(a[0],a[1]), pb=world(b[0],b[1]);
    const dx=pb.x-pa.x, dz=pb.z-pa.z, len=Math.hypot(dx,dz); if(len<.1)return;
    const m=new THREE.Mesh(new THREE.BoxGeometry(len,height,thickness),new THREE.MeshStandardMaterial({color,roughness:.9}));
    m.position.set((pa.x+pb.x)/2,height/2,(pa.z+pb.z)/2); m.rotation.y=-Math.atan2(dz,dx); m.castShadow=true; m.receiveShadow=true; parent.add(m);
  }
  function beamPath(parent, pts, color, radius=0.8, y=.6, opacity=1) {
    const v=pts.map(([x,y0])=>{const p=world(x,y0);return new THREE.Vector3(p.x,y,p.z);});
    const curve=new THREE.CatmullRomCurve3(v); const geo=new THREE.TubeGeometry(curve,Math.max(20,v.length*10),radius,7,false);
    const mat=new THREE.MeshStandardMaterial({color,transparent:opacity<1,opacity,emissive:color,emissiveIntensity:.08,roughness:.65});
    const mesh=new THREE.Mesh(geo,mat); parent.add(mesh); return mesh;
  }
  function bezier(p0,p1,p2,p3,t){const u=1-t;return [u*u*u*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*p3[0],u*u*u*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*p3[1]];}
  function curvedWindows(parent, curves, height=24, sill=5) {
    const frame=new THREE.MeshStandardMaterial({color:0x273d59,metalness:.32,roughness:.48});
    const glass=new THREE.MeshPhysicalMaterial({color:0xa8d7e8,transparent:true,opacity:.27,roughness:.18,metalness:.08,side:THREE.DoubleSide});
    const pts=[]; curves.forEach((c,ci)=>{for(let i=0;i<=22;i++){if(ci&&i===0)continue;pts.push(bezier(c[0],c[1],c[2],c[3],i/22));}});
    let acc=0,last=0;
    for(let i=0;i<pts.length-1;i++){
      const a=world(...pts[i]),b=world(...pts[i+1]),dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz); if(len<.15)continue;
      const pane=new THREE.Mesh(new THREE.BoxGeometry(len+.1,height-sill,0.8),glass);
      pane.position.set((a.x+b.x)/2,sill+(height-sill)/2,(a.z+b.z)/2); pane.rotation.y=-Math.atan2(dz,dx); parent.add(pane);
      acc+=len; if(acc-last>13){const mullion=new THREE.Mesh(new THREE.BoxGeometry(1.05,height-sill+1,1.25),frame);mullion.position.set(b.x,(height+sill)/2,b.z);parent.add(mullion);last=acc;}
    }
    const wp=pts.map(([x,y])=>world(x,y));
    for(const level of [sill,height]){const c=new THREE.CatmullRomCurve3(wp.map(p=>new THREE.Vector3(p.x,level,p.z)));parent.add(new THREE.Mesh(new THREE.TubeGeometry(c,80,.8,6,false),frame));}
  }
  function addColumn(parent,x,y) {const p=world(x,y);const m=new THREE.Mesh(new THREE.BoxGeometry(4.5,27,4.5),new THREE.MeshStandardMaterial({color:0xe8e6df,roughness:.88}));m.position.set(p.x,13.5,p.z);m.castShadow=true;parent.add(m);}
  function addStair(parent) {
    flatPolygon(parent, STAIR, 0xc7ced6, 1, .22);
    const a=world(34,279),b=world(131,307),dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz),ang=-Math.atan2(dz,dx);
    for(let i=0;i<12;i++){const step=new THREE.Mesh(new THREE.BoxGeometry(len*.82,1.1,5.3),new THREE.MeshStandardMaterial({color:0x9daaba,roughness:.86}));const t=(i+.5)/12;step.position.set(a.x+dx*t,1.05+i*.35,a.z+dz*t);step.rotation.y=ang;parent.add(step);}
    const railMat=new THREE.MeshStandardMaterial({color:0x53677f,metalness:.4,roughness:.48});
    for(const side of [-1,1]){const rail=new THREE.Mesh(new THREE.BoxGeometry(len*.84,.7,.65),railMat);rail.position.set((a.x+b.x)/2,7,(a.z+b.z)/2+side*5.5);rail.rotation.y=ang;parent.add(rail);}
  }
  function addBookshelf(parent,x,y,rot=0) {const p=world(x,y),g=new THREE.Group();const body=new THREE.Mesh(new THREE.BoxGeometry(12,15,4),new THREE.MeshStandardMaterial({color:0x816348,roughness:.8}));body.position.y=7.5;g.add(body);for(let k=0;k<3;k++){const shelf=new THREE.Mesh(new THREE.BoxGeometry(12.5,.7,4.5),new THREE.MeshStandardMaterial({color:0xd8cdbd}));shelf.position.y=3+k*4.2;g.add(shelf);for(let j=0;j<6;j++){const h=2+(j%3)*.4;const book=new THREE.Mesh(new THREE.BoxGeometry(1.2,h,2.8),new THREE.MeshStandardMaterial({color:[0x4c9ca9,0xd3a04b,0x7894bd,0x58a17d,0xb46d73][(j+k)%5]}));book.position.set(-5.2+j*2.05,3.3+k*4.2+h/2,0);g.add(book);}}g.position.set(p.x,0,p.z);g.rotation.y=rot;parent.add(g);}
  function addCeiling(parent) {
    // InstancedMesh evita cientos de objetos independientes cuando se activan las placas del techo.
    const g=new THREE.Group();
    const tileMat=new THREE.MeshStandardMaterial({color:0xf1f0e9,roughness:.92});
    const lightMat=new THREE.MeshStandardMaterial({color:0xfff3d4,emissive:0xffe7a3,emissiveIntensity:1.0});
    const tileGeo=new THREE.BoxGeometry(13.2,.45,13.2), lampGeo=new THREE.BoxGeometry(8.6,.2,3.2);
    const positions=[];
    for(let y=64,iy=0;y<395;y+=14,iy++) for(let x=35,ix=0;x<565;x+=14,ix++) if(inside(OUTER,x,y)&&!inside(STAIR,x,y)){const p=world(x,y);positions.push({x:p.x,z:p.z,lamp:(ix*3+iy)%8===0});}
    const tiles=new THREE.InstancedMesh(tileGeo,tileMat,positions.length), lamps=new THREE.InstancedMesh(lampGeo,lightMat,positions.filter(p=>p.lamp).length);
    const dummy=new THREE.Object3D();let li=0;
    positions.forEach((p,i)=>{dummy.position.set(p.x,31,p.z);dummy.updateMatrix();tiles.setMatrixAt(i,dummy.matrix);if(p.lamp){dummy.position.set(p.x,31.42,p.z);dummy.updateMatrix();lamps.setMatrixAt(li++,dummy.matrix);}});
    tiles.instanceMatrix.needsUpdate=true;lamps.instanceMatrix.needsUpdate=true;tiles.receiveShadow=true;g.add(tiles,lamps);parent.add(g);g.visible=false;return g;
  }
  function inside(poly,x,y){let on=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const [xi,yi]=poly[i],[xj,yj]=poly[j];if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi))on=!on;}return on;}
  function createArchitecture(sceneRoot){
    const s=new THREE.Shape();s.moveTo(43-293,121-225);s.lineTo(319-293,52-225);s.lineTo(326-293,127-225);s.bezierCurveTo(373-293,126-225,425-293,132-225,477-293,146-225);s.lineTo(491-293,111-225);s.lineTo(570-293,140-225);s.lineTo(562-293,171-225);s.lineTo(538-293,231-225);s.lineTo(491-293,366-225);s.bezierCurveTo(451-293,350-225,418-293,330-225,388-293,322-225);s.bezierCurveTo(345-293,311-225,305-293,309-225,264-293,316-225);s.bezierCurveTo(205-293,329-225,151-293,370-225,79-293,398-225);s.lineTo(43-293,358-225);s.lineTo(17-293,269-225);s.lineTo(99-293,227-225);s.closePath();
    const fg=new THREE.ShapeGeometry(s,3);fg.rotateX(-Math.PI/2);const floor=new THREE.Mesh(fg,new THREE.MeshStandardMaterial({color:0xdedbd2,roughness:.94,side:THREE.DoubleSide}));floor.receiveShadow=true;sceneRoot.add(floor);
    flatPolygon(sceneRoot,UPPER,0xa8cdb4,.34,.14);flatPolygon(sceneRoot,LOWER,0xa9c5df,.30,.15);
    // Baldosas discretas recortadas dentro de la planta.
    const pts=[];for(let y=66;y<392;y+=14){let start=null,prev=null;for(let x=22;x<=568;x+=1){const ok=inside(OUTER,x,y)&&!inside(STAIR,x,y);if(ok&&!start)start=[x,y];if(ok)prev=[x,y];if(!ok&&start){if(prev){const a=world(...start),b=world(...prev);pts.push(a.x,.23,a.z,b.x,.23,b.z);}start=null;}}if(start&&prev){const a=world(...start),b=world(...prev);pts.push(a.x,.23,a.z,b.x,.23,b.z);}}
    for(let x=38;x<565;x+=14){let start=null,prev=null;for(let y=54;y<=400;y+=1){const ok=inside(OUTER,x,y)&&!inside(STAIR,x,y);if(ok&&!start)start=[x,y];if(ok)prev=[x,y];if(!ok&&start){if(prev){const a=world(...start),b=world(...prev);pts.push(a.x,.23,a.z,b.x,.23,b.z);}start=null;}}if(start&&prev){const a=world(...start),b=world(...prev);pts.push(a.x,.23,a.z,b.x,.23,b.z);}}
    const tg=new THREE.BufferGeometry();tg.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));sceneRoot.add(new THREE.LineSegments(tg,new THREE.LineBasicMaterial({color:0xb9b7b0,transparent:true,opacity:.34})));
    const wallMat=0xe7e5dd;for(let i=0;i<OUTER.length;i++){const j=(i+1)%OUTER.length;if((i>=2&&i<=4)||(i>=10&&i<=18))continue;wall(sceneRoot,OUTER[i],OUTER[j],25,2.8,wallMat);}
    // Ambientes auxiliares respetando el croquis.
    [[ [44,121],[160,91],[173,173],[142,205],[96,226] ],[[162,91],[231,72],[238,128],[326,127],[322,52]],[[491,111],[570,140],[562,171],[478,146]]].forEach(poly=>{for(let i=0;i<poly.length;i++)wall(sceneRoot,poly[i],poly[(i+1)%poly.length],24,2.4,0xece9e1);});
    curvedWindows(sceneRoot,[[[326,127],[373,126],[425,132],[477,146]]],25,5.2);
    curvedWindows(sceneRoot,[[[491,366],[451,350],[418,330],[388,322]],[[388,322],[345,311],[305,309],[264,316]],[[264,316],[205,329],[151,370],[79,398]]],25,5.1);
    addStair(sceneRoot);[[243.5,219.5],[327.5,216.5],[415.5,224.5],[471.5,247.5],[289.5,307.5]].forEach(p=>addColumn(sceneRoot,p[0],p[1]));
    addBookshelf(sceneRoot,105,177,-.35);addBookshelf(sceneRoot,204,89,.12);addBookshelf(sceneRoot,528,151,.35);
    beamPath(sceneRoot,[[128,224],[198,224],[264,223],[334,223],[397,224],[455,224],[505,224]],0x28a27b,2.0,.38);
    [[[321,126],[321,175],[321,212]],[[132,158],[150,190],[163,215],[178,268]],[[218,92],[220,151],[225,212]],[[519,168],[512,205],[505,221],[491,286]]].forEach(p=>beamPath(sceneRoot,p,0x259d76,.72,.5));
    [[[337,108],[380,109],[423,115],[466,124]],[[58,282],[45,300],[55,340],[80,358],[100,350],[141,330]]].forEach(p=>beamPath(sceneRoot,p,0xd65d58,.62,.52));
    const grid=new THREE.GridHelper(720,48,0x314968,0x203753);grid.position.y=-1;sceneRoot.add(grid);
    return addCeiling(sceneRoot);
  }
  function addTable(parent, table, isNew){
    if(!table||![table.x,table.y,table.ancho,table.alto].every(v=>Number.isFinite(Number(v))))return;
    const w=Math.max(5,Number(table.ancho)),d=Math.max(4,Number(table.alto)),p=world(Number(table.x)+w/2,Number(table.y)+d/2),g=new THREE.Group();
    const wood=new THREE.MeshStandardMaterial({color:isNew?0xe79a35:0x15588f,roughness:.53,metalness:.04});const edge=new THREE.MeshStandardMaterial({color:isNew?0x9d5c16:0x102f4b,roughness:.62,metalness:.18});const metal=new THREE.MeshStandardMaterial({color:0x202a32,metalness:.38,roughness:.5});
    const top=new THREE.Mesh(new THREE.BoxGeometry(w,1.5,d),wood);top.position.y=8;top.castShadow=true;top.receiveShadow=true;g.add(top);const rim=new THREE.Mesh(new THREE.BoxGeometry(w+.6,.55,d+.6),edge);rim.position.y=7.2;g.add(rim);
    for(const sx of [-1,1])for(const sz of [-1,1]){const leg=new THREE.Mesh(new THREE.BoxGeometry(.75,7,.75),metal);leg.position.set(sx*(w/2-1),3.6,sz*(d/2-1));g.add(leg);}g.position.set(p.x,0,p.z);parent.add(g);
  }
  function addChair(parent, seat, isNew, table){
    if(!seat||![seat.x,seat.y,seat.ancho,seat.alto].every(v=>Number.isFinite(Number(v))))return;
    const w=Math.max(2.8,Number(seat.ancho)),d=Math.max(2.8,Number(seat.alto)),p=world(Number(seat.x)+w/2,Number(seat.y)+d/2);const g=new THREE.Group();
    const blue=new THREE.MeshStandardMaterial({color:isNew?0x26a579:0x299bb7,roughness:.7}),back=new THREE.MeshStandardMaterial({color:isNew?0x16815e:0x1e627f,roughness:.75}),metal=new THREE.MeshStandardMaterial({color:0x20272d,metalness:.32,roughness:.52});
    const yaw=table?Math.atan2((world(table.x+table.ancho/2,table.y+table.alto/2).x-p.x),(world(table.x+table.ancho/2,table.y+table.alto/2).z-p.z)):0;g.rotation.y=yaw;
    const top=new THREE.Mesh(new THREE.BoxGeometry(w,.85,d),blue);top.position.y=3;g.add(top);const rear=new THREE.Mesh(new THREE.BoxGeometry(w,.85,.8),back);rear.position.set(0,5.3,d*.43);g.add(rear);for(const sx of [-1,1]){const post=new THREE.Mesh(new THREE.BoxGeometry(.42,3.4,.42),metal);post.position.set(sx*w*.38,4.15,d*.42);g.add(post);for(const sz of [-1,1]){const leg=new THREE.Mesh(new THREE.BoxGeometry(.42,2.7,.42),metal);leg.position.set(sx*w*.36,1.35,sz*d*.34);g.add(leg);}}g.position.set(p.x,0,p.z);parent.add(g);
    return {x:p.x,z:p.z,yaw,svgX:Number(seat.x)+w/2,svgY:Number(seat.y)+d/2};
  }
  function addSofa(parent,x,y){
    const p=world(x+15,y+6.5),g=new THREE.Group(),base=new THREE.MeshStandardMaterial({color:0x79584b,roughness:.9}),cush=new THREE.MeshStandardMaterial({color:0xa37b68,roughness:.92});
    const seat=new THREE.Mesh(new THREE.BoxGeometry(30,3,13),base);seat.position.y=2;g.add(seat);
    const back=new THREE.Mesh(new THREE.BoxGeometry(30,8,2.7),base);back.position.set(0,7.1,5);g.add(back);
    for(let i=0;i<2;i++){const pillow=new THREE.Mesh(new THREE.BoxGeometry(13,1.4,8),cush);pillow.position.set(-7+i*14,4,0);g.add(pillow);}
    for(const side of [-1,1]){const arm=new THREE.Mesh(new THREE.BoxGeometry(2.7,6.2,13),base);arm.position.set(side*14,4.3,0);g.add(arm);}
    g.position.set(p.x,0,p.z);parent.add(g);
    // Dos plazas referenciales por sofá; no son asientos físicos levantados en campo.
    return [world(x+9,y+7),world(x+21,y+7)].map(q=>({x:q.x,z:q.z,yaw:0,svgX:x+9,svgY:y+7,sofa:true}));
  }
  function buildFurniture(parent, result){
    const chairOldMat=Number(result?.sillas_existentes_utilizadas??193);let oldCount=0;const seats=[];
    (result?.ubicaciones||[]).forEach(p=>{
      const mesa=p.mesa_svg||{};addTable(parent,mesa,p.tipo==='adicional');
      (p.sillas_svg||[]).forEach(s=>{const isNew=oldCount>=chairOldMat;oldCount++;const seat=addChair(parent,s,isNew,mesa);if(seat)seats.push(seat);});
    });
    const sofas=Number(result?.sofas_conservados??4),pos=[[188,274],[222,274],[188,291],[222,291]];
    for(let i=0;i<Math.min(4,sofas);i++)seats.push(...addSofa(parent,...pos[i]));
    return seats;
  }
  function buildActualFurniture(parent){
    const positions=[];
    const addRow=(xs,ys)=>ys.forEach(y=>xs.forEach(x=>{
      const table={x,y,ancho:17,alto:9};addTable(parent,table,false);
      [[x+3,y-3],[x+14,y-3],[x+3,y+12],[x+14,y+12]].forEach(([sx,sy])=>{const seat=addChair(parent,{x:sx,y:sy,ancho:4.5,alto:4.1},false,table);if(seat)positions.push(seat);});
    }));
    addRow([245,293,341,389,437],[145,161,177,193]);
    addRow([260,291,322,353,384,415,446],[243,260,277,294]);
    const extra=addChair(parent,{x:475,y:301,ancho:4.5,alto:4.1},false,{x:468,y:294,ancho:17,alto:9});if(extra)positions.push(extra);
    [[188,274],[222,274],[188,291],[222,291]].forEach(([x,y])=>positions.push(...addSofa(parent,x,y)));
    return positions;
  }
  function makeSeatRoute(seat){
    const laneX=Math.max(164,Math.min(505,Number(seat.svgX??293)));
    const raw=[[108,343],[128,322],[145,296],[158,269],[165,244],[167,224],[laneX,224],[Number(seat.svgX??laneX),Number(seat.svgY??225)]];
    const clean=[];raw.forEach(pt=>{const prev=clean[clean.length-1];if(!prev||Math.hypot(pt[0]-prev[0],pt[1]-prev[1])>2)clean.push(pt);});
    const pts=clean.map(([x,y])=>{const p=world(x,y);return new THREE.Vector3(p.x,0,p.z);});
    const curve=new THREE.CatmullRomCurve3(pts,false,'centripetal',.25);
    const length=curve.getLength();return {curve,duration:Math.max(6.5,Math.min(11.5,length/42))};
  }
  const SHARED_SIM_KEY = 'CRAI_SIM_CONCURRENCY_STATE_V1';
  function readSharedState(){try{return JSON.parse(localStorage.getItem(SHARED_SIM_KEY)||'null');}catch(_){return null;}}
  function fmtTimeLocal(m){const n=Math.max(0,Math.min(1439,Math.round(Number(m)||0)));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;}
  function smooth3(t){const x=Math.max(0,Math.min(1,t));return x*x*(3-2*x);}
  class Viewer{
    constructor(host){this.host=host;this.code=host.dataset.scenario||'A';this.id=host.id||`crai3d-${Math.random().toString(36).slice(2)}`;host.id=this.id;this.rendered=false;this.ceiling=null;this.controls=null;this.cameraMode='iso';this.seats=[];this.state=null;this.buildUi();this.init();}
    buildUi(){this.host.innerHTML=`<div class="crai3d-toolbar"><div class="crai3d-view-title">Vista isométrica 3D · Escenario ${this.code}</div><div class="crai3d-tools"><button type="button" data-view="iso">Isométrica</button><button type="button" data-view="top">Superior</button><button type="button" data-action="ceiling">Mostrar techo</button><button type="button" data-action="reset">Restablecer cámara</button></div></div><div class="crai3d-stage"><canvas aria-label="Vista 3D del segundo nivel del CRAI, escenario ${this.code}"></canvas><div class="crai3d-loading">Preparando modelo 3D...</div><div class="crai3d-live-badge">Concurrencia: <strong data-live-inside>—</strong> / <span data-live-capacity>—</span><span> · excedente <b data-live-excess>—</b></span><small data-live-time>Sube el Excel y reproduce la jornada en el dashboard principal</small></div></div><div class="crai3d-hint">Arrastra para girar · Rueda para acercar · Clic derecho para desplazar · Personas asignadas según concurrencia estimada y plazas disponibles</div>`;this.canvas=this.host.querySelector('canvas');this.loading=this.host.querySelector('.crai3d-loading');this.liveInside=this.host.querySelector('[data-live-inside]');this.liveCapacity=this.host.querySelector('[data-live-capacity]');this.liveExcess=this.host.querySelector('[data-live-excess]');this.liveTime=this.host.querySelector('[data-live-time]');this.host.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>this.setCamera(b.dataset.view)));this.host.querySelector('[data-action="ceiling"]').addEventListener('click',e=>{if(this.ceiling){this.ceiling.visible=!this.ceiling.visible;e.currentTarget.textContent=this.ceiling.visible?'Ocultar techo':'Mostrar techo';}});this.host.querySelector('[data-action="reset"]').addEventListener('click',()=>this.setCamera('iso'));}
    init(){this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x0a1730);this.scene.fog=new THREE.Fog(0x0a1730,500,1100);this.camera=new THREE.PerspectiveCamera(38,1,.1,2000);this.camera.position.set(280,260,340);this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,alpha:false,powerPreference:'high-performance'});this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;this.controls.dampingFactor=.07;this.controls.target.set(0,5,0);this.controls.minDistance=120;this.controls.maxDistance=700;this.scene.add(new THREE.HemisphereLight(0xe4efff,0x53627a,2.15));const key=new THREE.DirectionalLight(0xffffff,2.25);key.position.set(-180,260,170);key.castShadow=true;key.shadow.mapSize.set(1024,1024);this.scene.add(key);const fill=new THREE.DirectionalLight(0x89b9eb,.85);fill.position.set(200,120,-180);this.scene.add(fill);this.root=new THREE.Group();this.scene.add(this.root);this.ceiling=createArchitecture(this.root);this.furniture=new THREE.Group();this.root.add(this.furniture);this.createCrowd();this.resize();this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(this.host);this.renderer.setAnimationLoop(()=>{if(!this.host.isConnected)return;this.controls.update();this.animateCrowd(performance.now());this.renderer.render(this.scene,this.camera);});this.rendered=true;this.applyConcurrency(readSharedState());}
    createCrowd(){
      this.crowd=new THREE.Group();this.root.add(this.crowd);
      const capacity=260;
      const add=(name,geo)=>{const mat=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.82,metalness:.01});const mesh=new THREE.InstancedMesh(geo,mat,capacity);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;mesh.count=0;this.crowd.add(mesh);return mesh;};
      this.parts={torso:add('torso',new THREE.CapsuleGeometry(.82,3.1,4,8)),head:add('head',new THREE.SphereGeometry(.92,12,10)),hair:add('hair',new THREE.SphereGeometry(.96,10,8)),armL:add('armL',new THREE.CapsuleGeometry(.27,1.45,3,7)),armR:add('armR',new THREE.CapsuleGeometry(.27,1.45,3,7)),legL:add('legL',new THREE.CapsuleGeometry(.33,1.55,3,7)),legR:add('legR',new THREE.CapsuleGeometry(.33,1.55,3,7)),shoeL:add('shoeL',new THREE.BoxGeometry(.85,.5,1.35)),shoeR:add('shoeR',new THREE.BoxGeometry(.85,.5,1.35))};
      this.persons=[];this.lastCrowdFrame=0;
    }
    avatarColors(code,index){let h=0;const str=String(code||index);for(let i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))|0;const clothes=[0x3f8fbc,0x367a68,0x4d5f9b,0x9b7049,0x7c5f91,0xb16a62,0x546d7e,0x9b9d51];const skin=[0xd9aa86,0xc9916d,0xe5b998,0xb97e5e,0xeac8a7];const hair=[0x252a31,0x3a2d28,0x4b3b32,0x1e2632];const n=Math.abs(h);return {clothes:clothes[n%clothes.length],skin:skin[(n>>>3)%skin.length],hair:hair[(n>>>6)%hair.length]};}
    setPart(mesh,index,dummy,pos,yaw,scale,color,rx=0,rz=0){dummy.position.set(pos.x,pos.y,pos.z);dummy.rotation.set(rx,yaw,rz);dummy.scale.set(...scale);dummy.updateMatrix();mesh.setMatrixAt(index,dummy.matrix);mesh.setColorAt(index,new THREE.Color(color));}
    localPos(base,x,y,z,yaw){const c=Math.cos(yaw),s=Math.sin(yaw);return {x:base.x+x*c+z*s,y,z:base.z-x*s+z*c};}
    applyConcurrency(snapshot){
      this.state=snapshot||null;
      const empty=()=>{this.persons=[];Object.values(this.parts||{}).forEach(m=>{m.count=0;m.instanceMatrix.needsUpdate=true;});if(this.liveInside)this.liveInside.textContent='—';if(this.liveCapacity)this.liveCapacity.textContent=String(this.seats?.length||'—');if(this.liveExcess)this.liveExcess.textContent='—';if(this.liveTime)this.liveTime.textContent='Abre el dashboard principal, carga el Excel y reproduce la jornada.';};
      if(!snapshot||!Array.isArray(snapshot.events)){empty();return;}
      const time=Number(snapshot.minute)||0,peakStart=Number(snapshot.peakStart)||600,peakEnd=Number(snapshot.peakEnd)||840,peakStay=Number(snapshot.peakStayMinutes)||90,offStay=Number(snapshot.offPeakStayMinutes)||45;
      const cap=Math.min(this.seats.length,260),free=Array.from({length:cap},(_,i)=>i),active=[],unserved=[];
      const events=snapshot.events.map((e,i)=>({minute:Number(e[0]),code:String(e[1]||`visit-${i}`)})).filter(e=>Number.isFinite(e.minute)).sort((a,b)=>a.minute-b.minute);
      for(const ev of events){if(ev.minute>time)break;
        for(let i=active.length-1;i>=0;i--)if(active[i].departure<=ev.minute){free.push(active[i].seatIndex);active.splice(i,1);}
        for(let i=unserved.length-1;i>=0;i--)if(unserved[i].departure<=ev.minute)unserved.splice(i,1);
        free.sort((a,b)=>a-b);const dwell=ev.minute>=peakStart&&ev.minute<peakEnd?peakStay:offStay;
        if(free.length){const seatIndex=free.shift();active.push({code:ev.code,arrival:ev.minute,departure:ev.minute+dwell,seatIndex,dwell});}else unserved.push({code:ev.code,arrival:ev.minute,departure:ev.minute+dwell});
      }
      this.persons=active.filter(a=>a.departure>time).map(a=>({...a,seat:this.seats[a.seatIndex],route:this.routes[a.seatIndex]}));
      const demand=this.persons.length+unserved.filter(a=>a.departure>time).length;
      const assigned=this.persons.length,excess=Math.max(0,demand-assigned);
      if(this.liveInside)this.liveInside.textContent=fmt.format(assigned);
      if(this.liveCapacity)this.liveCapacity.textContent=fmt.format(this.seats.length);
      if(this.liveExcess)this.liveExcess.textContent=fmt.format(excess);
      if(this.liveTime)this.liveTime.textContent=`${snapshot.date||'—'} · ${fmtTimeLocal(time)} · demanda ${fmt.format(demand)} · permanencia pico ${peakStay} min / fuera de pico ${offStay} min`;
      this.updateCrowdMatrices(time);
    }
    updateCrowdMatrices(time){
      const list=(this.persons||[]).slice(0,260),dummy=new THREE.Object3D(),parts=this.parts;if(!parts)return;
      const set=(mesh,i,pos,yaw,scale,color,rx=0,rz=0)=>this.setPart(mesh,i,dummy,pos,yaw,scale,color,rx,rz);
      list.forEach((a,i)=>{
        const seat=a.seat||{x:0,z:0,yaw:0},route=a.route,age=Math.max(0,time-a.arrival),remaining=Math.max(0,a.departure-time),walkIn=route?.duration||8,walkOut=Math.min(walkIn,a.dwell*.16);
        let pose='sit',base={x:seat.x,y:0,z:seat.z},yaw=Number(seat.yaw)||0,phase=0;
        if(route&&age<walkIn){const u=smooth3(age/walkIn);base=route.curve.getPointAt(u);const t=route.curve.getTangentAt(Math.max(.001,Math.min(.999,u)));yaw=Math.atan2(t.x,t.z);phase=age*1.45;pose='walk';}
        else if(route&&remaining<walkOut){const u=smooth3(remaining/walkOut);base=route.curve.getPointAt(1-u);const t=route.curve.getTangentAt(Math.max(.001,Math.min(.999,1-u)));yaw=Math.atan2(-t.x,-t.z);phase=(a.dwell-remaining)*1.45;pose='walk';}
        const pal=this.avatarColors(a.code,i),walking=pose==='walk',bob=walking?Math.abs(Math.sin(phase))*.25:Math.sin(time*.16+i)*.04;
        const torso=this.localPos(base,0,walking?5.0+bob:4.55+bob,0,yaw),head=this.localPos(base,0,walking?8.5+bob:7.75+bob,0,yaw),hair=this.localPos(base,0,walking?9.2+bob:8.48+bob,-.05,yaw);
        set(parts.torso,i,torso,yaw,[1,1,1],pal.clothes,walking?Math.sin(phase)*.04:.13,0);
        set(parts.head,i,head,yaw,[.88,.94,.88],pal.skin,0,0);set(parts.hair,i,hair,yaw,[1,.55,1],pal.hair,.1,0);
        const armSwing=walking?Math.sin(phase)*.55:0;
        set(parts.armL,i,this.localPos(base,-1.15,walking?5.0:4.55,walking?0:.9,yaw),yaw,[1,1,1],pal.skin,walking?armSwing:-.72,walking?-.1:.05);
        set(parts.armR,i,this.localPos(base,1.15,walking?5.0:4.55,walking?0:.9,yaw),yaw,[1,1,1],pal.skin,walking?-armSwing:-.72,walking?.1:-.05);
        const legSwing=walking?Math.sin(phase)*.48:0;
        set(parts.legL,i,this.localPos(base,-.45,walking?2.0:1.65,walking?0:1.05,yaw),yaw,[1,1,1],0x263746,walking?legSwing:1.06,0);
        set(parts.legR,i,this.localPos(base,.45,walking?2.0:1.65,walking?0:1.05,yaw),yaw,[1,1,1],0x263746,walking?-legSwing:1.06,0);
        set(parts.shoeL,i,this.localPos(base,-.45,.38,walking?.12:1.75,yaw),yaw,[1,1,1],0x20252b,0,0);
        set(parts.shoeR,i,this.localPos(base,.45,.38,walking?-.12:1.75,yaw),yaw,[1,1,1],0x20252b,0,0);
      });
      Object.values(parts).forEach(m=>{m.count=list.length;m.instanceMatrix.needsUpdate=true;if(m.instanceColor)m.instanceColor.needsUpdate=true;});
    }
    animateCrowd(now){
      if(!this.persons?.length||!this.state||now-this.lastCrowdFrame<85)return;
      this.lastCrowdFrame=now;
      const elapsed=this.state.playing?Math.max(0,(Date.now()-Number(this.state.updatedAt||Date.now()))/1000)*2*Number(this.state.speed||1):0;
      const currentMinute=Math.min(1110,Number(this.state.minute||0)+elapsed);
      this.updateCrowdMatrices(currentMinute);
    }
    resize(){const stage=this.host.querySelector('.crai3d-stage');if(!stage)return;const w=Math.max(280,stage.clientWidth),h=Math.max(250,stage.clientHeight);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);}
    setCamera(mode){this.cameraMode=mode;if(mode==='top'){this.camera.position.set(0,520,1);this.controls.target.set(0,3,0);}else{this.camera.position.set(280,260,340);this.controls.target.set(0,5,0);}this.controls.update();}
    setActual(){this.furniture.clear();this.seats=buildActualFurniture(this.furniture);this.routes=this.seats.map(makeSeatRoute);this.loading.style.display='none';this.host.querySelector('.crai3d-view-title').textContent='CRAI actual · 48 mesas · 193 sillas · 4 sofás · 201 plazas';this.applyConcurrency(readSharedState());}
    setResult(result){this.furniture.clear();if(!result){this.seats=[];this.routes=[];this.applyConcurrency(null);this.loading.textContent='No se encontró el escenario seleccionado en los resultados guardados de CBC.';this.loading.style.display='grid';return;}this.seats=buildFurniture(this.furniture,result);this.routes=this.seats.map(makeSeatRoute);this.loading.style.display='none';this.host.querySelector('.crai3d-view-title').textContent=`Vista isométrica 3D · ${result.escenario||`Escenario ${result.codigo}`} · ${result.ubicaciones?.length||0} estaciones`;this.applyConcurrency(readSharedState());}
    dispose(){this.renderer.setAnimationLoop(null);this.observer?.disconnect();this.controls.dispose();this.renderer.dispose();}
  }
  async function loadData(){if(dataCache)return dataCache;const r=await fetch('/api/plem/resultados',{cache:'no-store'});const payload=await r.json();if(!r.ok||!payload.ok||!payload.disponible||!(payload.datos?.resultados||payload.resultados))throw new Error(payload.mensaje||payload.error||'No hay resultados CBC guardados.');dataCache=payload.datos||payload;return dataCache;}
  function resultBy(code,data=dataCache){return data?.resultados?.find(r=>r.codigo===code)||null;}
  const mounted=[];
  function renderHost(host,data){
    let viewer=viewers.get(host.id);
    try {
      if(!viewer){viewer=new Viewer(host);viewers.set(host.id,viewer);}
      if(host.dataset.crai3dActual==='true'){viewer.setActual();return viewer;}
      let result=resultBy(host.dataset.scenario,data);
      if(!result&&host.dataset.crai3dSingle==='true'&&data?.resultados?.length===1)result=data.resultados[0];
      viewer.setResult(result);return viewer;
    } catch(error) {
      console.error('CRAI 3D: error construyendo la escena',host.id,error);
      host.innerHTML=`<div class="crai3d-empty"><strong>No se pudo construir esta escena 3D.</strong><br>${String(error.message||error)}<br>Comprueba WebGL, la conexión y vuelve a cargar la página.</div>`;
      return null;
    }
  }
  async function renderAll(){
    mounted.forEach(host=>{if(host.dataset.crai3dActual==='true')renderHost(host,null);});
    const resultHosts=mounted.filter(host=>host.dataset.crai3dActual!=='true');
    if(!resultHosts.length)return;
    try {
      const data=await loadData();
      const needsAll=resultHosts.some(host=>host.dataset.crai3dSingle!=='true');
      if(needsAll){
        const codes=new Set((data.resultados||[]).map(r=>r.codigo));
        const exact=data.modo_ejecucion==='COMPARACION_COMPLETA_EXACTA'&&['A','B','C'].every(c=>codes.has(c))&&(data.resultados||[]).filter(r=>['A','B','C'].includes(r.codigo)).every(r=>r.optimalidad_demostrada===true&&String(r.estado).toLowerCase()==='optimal');
        if(!exact)throw new Error('La comparación guardada no es A/B/C exacta con CBC en estado Optimal. Ejecuta la comparación completa exacta en el módulo CBC.');
      }
      resultHosts.forEach(host=>renderHost(host,data));
    } catch(err) {
      resultHosts.forEach(host=>{host.innerHTML=`<div class="crai3d-empty"><strong>No hay resultados CBC válidos para esta vista.</strong><br>${String(err.message||err)}<br>Ejecuta y guarda la comparación completa exacta A/B/C en el módulo CBC.</div>`;});
    }
  }
  function updateData(data){dataCache=data;mounted.forEach(host=>{if(host.dataset.crai3dActual!=='true')renderHost(host,data);});}
  function selectScenario(code){document.querySelectorAll('[data-crai3d-view][data-crai3d-single]').forEach(host=>{host.dataset.scenario=code;renderHost(host,dataCache);});}
  function init(){document.querySelectorAll('[data-crai3d-view]').forEach(h=>mounted.push(h));if(!mounted.length)return;['spatialScenarioSelect','scenarioSelect','spatialRunScenario'].forEach(id=>$(id)?.addEventListener('change',e=>selectScenario(e.target.value)));renderAll();}
  window.addEventListener('crai:plem-results',e=>{if(e.detail)updateData(e.detail);});
  window.addEventListener('storage',e=>{if(e.key===SHARED_SIM_KEY){const state=readSharedState();viewers.forEach(v=>v.applyConcurrency(state));}});
  window.addEventListener('crai:concurrency-state',e=>{if(e.detail)viewers.forEach(v=>v.applyConcurrency(e.detail));});
  window.CRAI3DViews={refresh:renderAll,updateData,selectScenario,viewers};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
