/* CRAI · Gráficos cuantitativos en proyección isométrica 3D.
   Los datos se conservan; se representan como prismas extruidos para mejorar la presentación. */
(() => {
  'use strict';
  const cache = new Map();
  const hosts = new Map();
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const palette = ['#3568e8','#1b9a79','#e28b24','#7867c8','#259ab4','#c85f75'];

  const css = `
  .crai3d-data-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:12px 0}
  .crai3d-data-card{min-width:0;background:#fff;border:1px solid #dfe7f1;border-radius:13px;padding:12px;box-shadow:0 5px 16px rgba(22,43,73,.05)}
  .crai3d-data-card.wide{grid-column:1/-1}
  .crai3d-chart-shell{min-width:0}
  .crai3d-chart-head{display:flex;justify-content:space-between;align-items:flex-start;gap:9px;flex-wrap:wrap;margin-bottom:5px}
  .crai3d-chart-head strong{display:block;color:#1d3556;font-size:11px;font-weight:850}
  .crai3d-chart-head small{display:block;color:#708198;font-size:8px;line-height:1.5;margin-top:3px}
  .crai3d-chart-tools{display:flex;gap:5px;flex-wrap:wrap}
  .crai3d-chart-tools button{border:1px solid #d7e1ef;background:#f5f8fc;color:#36577e;border-radius:6px;padding:5px 7px;font-size:8px;font-weight:750;cursor:pointer}
  .crai3d-chart-tools button.active{background:#1d3d6d;color:#fff;border-color:#1d3d6d}
  .crai3d-chart-svg{width:100%;height:285px;min-height:220px;overflow:hidden;border:1px solid #e6edf5;border-radius:9px;background:linear-gradient(145deg,#fbfdff,#f0f4fa)}
  .crai3d-chart-svg svg{display:block;width:100%;height:100%}
  .crai3d-chart-footer{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-top:7px}
  .crai3d-chart-legend{display:flex;gap:10px;flex-wrap:wrap}
  .crai3d-chart-legend-item{display:inline-flex;gap:4px;align-items:center;font-size:8px;color:#65758b}
  .crai3d-chart-legend-item i{width:8px;height:8px;border-radius:2px;display:inline-block}
  .crai3d-chart-footer small{font-size:8px;color:#7a8aa0;line-height:1.45}
  .crai3d-chart-empty{padding:18px;border:1px dashed #bfccdc;background:#f7faff;border-radius:9px;color:#63748b;font-size:9px;line-height:1.5}
  .crai3d-2d-reference{margin-top:10px;border:1px solid #dfe7f1;border-radius:10px;padding:9px;background:#fbfcfe}
  .crai3d-2d-reference summary{cursor:pointer;font-size:9px;font-weight:800;color:#36557e}
  @media(max-width:850px){.crai3d-data-grid{grid-template-columns:1fr}.crai3d-data-card.wide{grid-column:auto}.crai3d-chart-svg{height:255px}}
  @media print{.crai3d-chart-tools{display:none}.crai3d-chart-svg{height:230px;break-inside:avoid}.crai3d-data-card{break-inside:avoid}}
  `;
  function injectCss(){if(document.getElementById('crai3d-chart-css'))return;const style=document.createElement('style');style.id='crai3d-chart-css';style.textContent=css;document.head.appendChild(style);}

  function normalize(payload) {
    if (!payload || !Array.isArray(payload.labels) || !Array.isArray(payload.series)) return null;
    const labels = payload.labels.map(v => String(v));
    const series = payload.series.map((s,i) => ({
      name: String(s.name || `Serie ${i+1}`),
      color: s.color || palette[i % palette.length],
      values: Array.isArray(s.values) ? s.values.map(v => Math.max(0, Number(v) || 0)) : []
    })).filter(s => s.values.length === labels.length);
    if (!labels.length || !series.length) return null;
    let chosen = labels.map((_,i)=>i);
    const maxBars = Number(payload.maxBars || (labels.length > 36 ? 32 : 36));
    if (chosen.length > maxBars) {
      const stride = (chosen.length - 1) / (maxBars - 1);
      chosen = Array.from({length:maxBars},(_,i)=>Math.round(i*stride));
    }
    return {
      title: String(payload.title || 'Visualización 3D'),
      subtitle: String(payload.subtitle || 'Representación tridimensional de los datos seleccionados'),
      labels: chosen.map(i=>labels[i]),
      series: series.map(s=>({...s,values:chosen.map(i=>s.values[i])})),
      unit: String(payload.unit || ''),
      note: payload.note || '',
      mode: 'iso'
    };
  }
  function shade(hex,amt){
    const s=String(hex).replace('#',''); if(s.length!==6)return hex;
    const n=parseInt(s,16);const r=Math.max(0,Math.min(255,(n>>16)+amt)),g=Math.max(0,Math.min(255,((n>>8)&255)+amt)),b=Math.max(0,Math.min(255,(n&255)+amt));
    return '#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  function shortLabel(s,max){s=String(s);return s.length>max?s.slice(0,max-1)+'…':s;}

  function prismChart(data, mode='iso') {
    const W=960,H=390,left=74,baseY=292,scaleY=190;
    const n=data.labels.length,m=data.series.length;
    const spacing=Math.min(25,790/Math.max(1,n));
    const groupWidth=Math.max(8,spacing*.72);
    const barW=Math.max(3,groupWidth/Math.max(1,m)*.78);
    const depth=Math.min(11,Math.max(5,spacing*.45));
    const max=Math.max(1,...data.series.flatMap(s=>s.values));
    const ceil=Math.ceil(max/4)*4 || 1;
    const iso=mode==='iso', dx=1, dxy=iso?.18:0, dzx=iso?-.52:0, dzy=iso?.18:0;
    const project=(x,y,z)=>[left+x*spacing+z*dzx,baseY+x*dxy+z*dzy-y*scaleY/ceil];
    const poly=(pts,fill,stroke='#ffffff',sw=.8)=>`<polygon points="${pts.map(p=>p.join(',')).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    const text=(x,y,t,attrs='')=>`<text x="${x}" y="${y}" ${attrs}>${esc(t)}</text>`;
    let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(data.title)} en gráfico tridimensional" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="craiChartFloor${Math.random().toString(36).slice(2,7)}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbfdff"/><stop offset="1" stop-color="#e7eef8"/></linearGradient><filter id="craiChartShadow" x="-20%" y="-20%" width="150%" height="160%"><feDropShadow dx="1.2" dy="2" stdDeviation="1.8" flood-color="#203b61" flood-opacity=".16"/></filter></defs>`;
    const endX=n*spacing+10,endZ=m*depth+10;
    const p00=project(-.8,0,-5),p10=project(n+.6,0,-5),p11=project(n+.6,0,endZ),p01=project(-.8,0,endZ);
    svg+=poly([p00,p10,p11,p01],'#eef3fa','#cbd6e5',1);
    for(let t=0;t<=4;t++){
      const v=t*ceil/4,yy=baseY-v*scaleY/ceil;
      svg+=`<line x1="${left-9}" y1="${yy}" x2="${left+endX}" y2="${yy+endX*dxy}" stroke="#d1dbe8" stroke-width=".8" stroke-dasharray="3 4"/>`;
      svg+=text(left-17,yy+3,Math.round(v).toLocaleString('es-PE'),`font-size="9" text-anchor="end" fill="#65778f"`);
    }
    data.labels.forEach((label,i)=>{
      data.series.forEach((s,j)=>{
        const value=s.values[i]||0;if(value<=0)return;
        const x=i*spacing+3+j*(groupWidth/m),z=j*depth+5;
        const h=Math.max(.8,value/max*ceil);
        const a=project(x,0,z),b=project(x+barW,0,z),c=project(x+barW,h,z),d=project(x,h,z);
        const e=project(x+barW,0,z+depth*.65),f=project(x+barW,h,z+depth*.65),g=project(x,h,z+depth*.65);
        svg+=`<g filter="url(#craiChartShadow)"><title>${esc(label)} · ${esc(s.name)}: ${value.toLocaleString('es-PE')} ${esc(data.unit)}</title>`;
        svg+=poly([b,e,f,c],shade(s.color,-24),'#ffffff',.6);
        svg+=poly([d,c,f,g],shade(s.color,25),'#ffffff',.6);
        svg+=poly([a,b,c,d],s.color,'#ffffff',.6);
        if(n<=14)svg+=text((a[0]+b[0])/2,d[1]-5,Math.round(value).toLocaleString('es-PE'),`font-size="8" font-weight="800" text-anchor="middle" fill="#20344f"`);
        svg+='</g>';
      });
      if(n<=18||i%(Math.ceil(n/12))===0){const xx=project(i*spacing+groupWidth/2,0,endZ+3);svg+=text(xx[0],xx[1]+13,shortLabel(label,11),`font-size="8" text-anchor="middle" fill="#52647d"`);}
    });
    svg+=`<line x1="${left-10}" y1="${baseY+3}" x2="${left-10}" y2="${baseY-scaleY-3}" stroke="#71839b" stroke-width="1.4"/><line x1="${left-10}" y1="${baseY+3}" x2="${left+endX}" y2="${baseY+3+endX*dxy}" stroke="#71839b" stroke-width="1.4"/>`;
    svg+='</svg>';
    const legends=data.series.map(s=>`<span class="crai3d-chart-legend-item"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    return `<div class="crai3d-chart-shell"><div class="crai3d-chart-head"><div><strong>${esc(data.title)}</strong><small>${esc(data.subtitle)}</small></div><div class="crai3d-chart-tools"><button type="button" data-crai3d-mode="iso" class="${mode==='iso'?'active':''}">Isométrica</button><button type="button" data-crai3d-mode="front" class="${mode==='front'?'active':''}">Frontal 3D</button></div></div><div class="crai3d-chart-svg">${svg}</div><div class="crai3d-chart-footer"><div class="crai3d-chart-legend">${legends}</div>${data.note?`<small>${esc(data.note)}</small>`:''}</div></div>`;
  }
  function render(id,payload,mode='iso'){
    const host=hosts.get(id)||$(id);if(!host)return;hosts.set(id,host);const data=normalize(payload);
    if(!data){host.innerHTML='<div class="crai3d-chart-empty">No hay datos suficientes para construir esta visualización.</div>';return;}
    cache.set(id,{payload,mode});host.dataset.crai3dChartReady='true';host.innerHTML=prismChart(data,mode);
    host.querySelectorAll('[data-crai3d-mode]').forEach(btn=>btn.addEventListener('click',()=>render(id,payload,btn.dataset.crai3dMode)));
  }
  function setAll(charts){if(!charts||typeof charts!=='object')return;window.CRAI_PENDING_3D_CHARTS={...(window.CRAI_PENDING_3D_CHARTS||{}),...charts};Object.entries(charts).forEach(([id,p])=>render(id,p));}
  function plemCharts(data){
    const rs=[...(data?.resultados||[])].filter(r=>['A','B','C'].includes(r.codigo)).sort((a,b)=>a.codigo.localeCompare(b.codigo));if(!rs.length)return;
    const labels=rs.map(r=>`Escenario ${r.codigo}`);
    setAll({
      compareCapacity3D:{title:'Estudiantes atendidos por escenario',subtitle:'Capacidad obtenida por CBC',labels,series:[{name:'Atendidos',color:'#3568e8',values:rs.map(r=>Number(r.estudiantes_atendidos)||0)}],unit:'estudiantes'},
      compareFurniture3D:{title:'Mobiliario adicional',subtitle:'Mesas y sillas nuevas por escenario',labels,series:[{name:'Mesas nuevas',color:'#e28b24',values:rs.map(r=>Number(r.mesas_nuevas)||0)},{name:'Sillas nuevas',color:'#1b9a79',values:rs.map(r=>Number(r.sillas_nuevas)||0)}],unit:'unidades'},
      compareZones3D:{title:'Estaciones por zona',subtitle:'Reparto de ubicaciones seleccionadas',labels,series:[{name:'Zona superior',color:'#1b9a79',values:rs.map(r=>Number(r.zonas?.SUPERIOR)||0)},{name:'Zona inferior',color:'#89a9d8',values:rs.map(r=>Number(r.zonas?.INFERIOR)||0)}],unit:'estaciones'},
      compareOrientation3D:{title:'Orientación de estaciones',subtitle:'Horizontal frente a vertical',labels,series:[{name:'Horizontal',color:'#7867c8',values:rs.map(r=>Number(r.orientaciones?.H)||0)},{name:'Vertical',color:'#e28b24',values:rs.map(r=>Number(r.orientaciones?.V)||0)}],unit:'estaciones'},
      proposalFurniture3D:{title:'Mobiliario por propuesta',subtitle:'Incorporación necesaria según alternativa',labels,series:[{name:'Mesas nuevas',color:'#e28b24',values:rs.map(r=>Number(r.mesas_nuevas)||0)},{name:'Sillas nuevas',color:'#1b9a79',values:rs.map(r=>Number(r.sillas_nuevas)||0)}],unit:'unidades'},
      proposalZones3D:{title:'Distribución de estaciones por zona',subtitle:'Ubicaciones de la solución CBC',labels,series:[{name:'Superior',color:'#1b9a79',values:rs.map(r=>Number(r.zonas?.SUPERIOR)||0)},{name:'Inferior',color:'#89a9d8',values:rs.map(r=>Number(r.zonas?.INFERIOR)||0)}],unit:'estaciones'},
      proposalConfigurations3D:{title:'Configuración de sillas por mesa',subtitle:'Mesas seleccionadas para 2, 3 o 4 estudiantes',labels,series:[{name:'2 sillas',color:'#259ab4',values:rs.map(r=>Number(r.configuraciones?.['2'])||0)},{name:'3 sillas',color:'#e28b24',values:rs.map(r=>Number(r.configuraciones?.['3'])||0)},{name:'4 sillas',color:'#3568e8',values:rs.map(r=>Number(r.configuraciones?.['4'])||0)}],unit:'mesas'},
      proposalOrientation3D:{title:'Orientación de estaciones',subtitle:'Distribución horizontal y vertical',labels,series:[{name:'Horizontal',color:'#7867c8',values:rs.map(r=>Number(r.orientaciones?.H)||0)},{name:'Vertical',color:'#e28b24',values:rs.map(r=>Number(r.orientaciones?.V)||0)}],unit:'estaciones'},
      cbcFurniture3D:{title:'Inventario adicional requerido',subtitle:'Requerimientos de mesas y sillas por escenario',labels,series:[{name:'Mesas nuevas',color:'#e28b24',values:rs.map(r=>Number(r.mesas_nuevas)||0)},{name:'Sillas nuevas',color:'#1b9a79',values:rs.map(r=>Number(r.sillas_nuevas)||0)}],unit:'unidades'},
      cbcConfigurations3D:{title:'Configuraciones de estaciones',subtitle:'Distribución de mesas para 2, 3 y 4 sillas',labels,series:[{name:'2 sillas',color:'#259ab4',values:rs.map(r=>Number(r.configuraciones?.['2'])||0)},{name:'3 sillas',color:'#e28b24',values:rs.map(r=>Number(r.configuraciones?.['3'])||0)},{name:'4 sillas',color:'#3568e8',values:rs.map(r=>Number(r.configuraciones?.['4'])||0)}],unit:'mesas'},
      cbcZones3D:{title:'Ubicaciones seleccionadas por zona',subtitle:'Distribución espacial del resultado CBC',labels,series:[{name:'Superior',color:'#1b9a79',values:rs.map(r=>Number(r.zonas?.SUPERIOR)||0)},{name:'Inferior',color:'#89a9d8',values:rs.map(r=>Number(r.zonas?.INFERIOR)||0)}],unit:'estaciones'}
    });
  }
  function init(){injectCss();document.querySelectorAll('[data-crai3d-chart]').forEach(h=>hosts.set(h.dataset.crai3dChart||h.id,h));if(window.CRAI_PENDING_3D_CHARTS)setAll(window.CRAI_PENDING_3D_CHARTS);if(window.CRAI_LAST_PLEM_DATA)plemCharts(window.CRAI_LAST_PLEM_DATA);}
  window.addEventListener('crai:charts-data',e=>setAll(e.detail||{}));
  window.addEventListener('crai:plem-results',e=>{window.CRAI_LAST_PLEM_DATA=e.detail||null;plemCharts(e.detail||{});});
  window.CRAI3DCharts={setAll,render,plemCharts,hosts};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
