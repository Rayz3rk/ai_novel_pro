import { useEffect,useRef,useState } from 'react';
import { ArrowRight,Link2,Minus,Plus,RotateCcw } from 'lucide-react';
import type { AtlasRelation,AtlasView,StoryEntry } from '@shujian/contracts';
import { atlasKinds } from '../lib/atlas-api';

interface Props {
  nodes:StoryEntry[];relations:AtlasRelation[];positions:AtlasView['positions'];selected:string[];focusId:string|null;
  onSelect:(id:string,toggle:boolean)=>void;onMove:(id:string,point:{x:number;y:number})=>void;
  onRelation:(fromId:string,toId:string)=>void;onInspectRelation:(relation:AtlasRelation)=>void;
}
export function AtlasGraph({nodes,relations,positions,selected,focusId,onSelect,onMove,onRelation,onInspectRelation}:Props){
  const area=useRef<HTMLDivElement>(null),drag=useRef<{id:string;startX:number;startY:number;moved:boolean;point:{x:number;y:number}}|null>(null),suppress=useRef(false);
  const [width,setWidth]=useState(800),[zoom,setZoom]=useState(1),[connect,setConnect]=useState<string|null>(null),[local,setLocal]=useState<AtlasView['positions']>({});
  useEffect(()=>setLocal({}),[positions]);
  useEffect(()=>{const element=area.current;if(!element)return;const observer=new ResizeObserver(()=>setWidth(element.clientWidth));observer.observe(element);return()=>observer.disconnect();},[]);
  const cols=width<550?2:width<850?4:5,rows=Math.max(2,Math.ceil(nodes.length/cols)),height=Math.max(480,rows*150),logicalWidth=width*zoom,logicalHeight=height*zoom;
  const points=new Map(nodes.map((node,index)=>[node.id,local[node.id]??positions[node.id]??{x:(index%cols+.5)/cols,y:(Math.floor(index/cols)+.5)/rows}]));
  const choose=(node:StoryEntry,toggle:boolean)=>{if(suppress.current){suppress.current=false;return;}if(connect){if(connect!==node.id)onRelation(connect,node.id);setConnect(null);}else onSelect(node.id,toggle);};
  const nodeWidth=width<550?108:132,nodeHeight=58;
  return <div className="atlas-graph">
    <div className="atlas-graph-tools"><span>{nodes.length} 张卡片 · {relations.length} 条关系</span><div><button type="button" className="text-button" disabled={!focusId} onClick={()=>setConnect(connect?null:focusId)}><Link2 size={14}/>{connect?'取消连线':'从选中卡片连线'}</button><button type="button" className="icon-button" aria-label="缩小图谱" disabled={zoom<=.8} onClick={()=>setZoom(value=>Math.max(.8,value-.2))}><Minus size={15}/></button><span>{Math.round(zoom*100)}%</span><button type="button" className="icon-button" aria-label="放大图谱" disabled={zoom>=2} onClick={()=>setZoom(value=>Math.min(2,value+.2))}><Plus size={15}/></button><button type="button" className="icon-button" aria-label="还原图谱缩放" onClick={()=>setZoom(1)}><RotateCcw size={14}/></button></div></div>
    {connect&&<p className="notice" role="status">已选择起点。点击另一张卡片建立关系，也可用 Tab 和 Enter 选择。</p>}
    <div className="atlas-graph-viewport" ref={area}>
      <div className="atlas-graph-world" style={{width:logicalWidth,height:logicalHeight}}>
        <svg className="atlas-graph-edges" width={logicalWidth} height={logicalHeight} viewBox={`0 0 ${logicalWidth} ${logicalHeight}`} role="img" aria-label="本书人物、道具、地点与场景的关系图">
          <defs><marker id="atlas-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L7 3.5L0 7Z" fill="currentColor"/></marker></defs>
          {relations.map((edge)=>{const a=points.get(edge.fromId),b=points.get(edge.toId);if(!a||!b)return null;const x1=a.x*logicalWidth,y1=a.y*logicalHeight,x2=b.x*logicalWidth,y2=b.y*logicalHeight,dx=x2-x1,dy=y2-y1,length=Math.hypot(dx,dy)||1,ux=dx/length,uy=dy/length;
            const inset=Math.min((nodeWidth/2+8)/Math.max(.001,Math.abs(ux)),(nodeHeight/2+8)/Math.max(.001,Math.abs(uy)));
            const sx=x1+ux*inset,sy=y1+uy*inset,ex=x2-ux*inset,ey=y2-uy*inset;
            const pair=relations.filter(row=>row.fromId===edge.fromId&&row.toId===edge.toId||row.fromId===edge.toId&&row.toId===edge.fromId),offset=pair.length>1?(pair.findIndex(row=>row.id===edge.id)-(pair.length-1)/2)*35:0,cx=(sx+ex)/2-uy*offset,cy=(sy+ey)/2+ux*offset;
            return <g key={edge.id} className={`atlas-edge ${edge.phase==='idea'?'idea':''} ${edge.needsReview?'stale':''}`}><path d={`M${sx},${sy} Q${cx},${cy} ${ex},${ey}`} markerEnd={edge.symmetric?undefined:'url(#atlas-arrow)'}/><text x={(sx+2*cx+ex)/4} y={(sy+2*cy+ey)/4-7} textAnchor="middle">{edge.label.length>12?edge.label.slice(0,12)+'…':edge.label}</text><title>{edge.label} · 第 {edge.fromChapter} 章起</title></g>;
          })}
        </svg>
        {nodes.map(node=>{const point=points.get(node.id)!;return <button key={node.id} type="button" className={`atlas-node ${node.kind} ${node.status==='idea'?'idea':''} ${focusId===node.id?'focused':''} ${selected.includes(node.id)?'picked':''}`} style={{left:point.x*logicalWidth,top:point.y*logicalHeight,width:nodeWidth}} aria-label={`图谱卡片：${node.title}`} aria-pressed={selected.includes(node.id)} title={node.title} onClick={event=>choose(node,event.shiftKey||event.ctrlKey||event.metaKey)}
          onPointerDown={event=>{if(event.button!==0)return;drag.current={id:node.id,startX:event.clientX,startY:event.clientY,moved:false,point};event.currentTarget.setPointerCapture(event.pointerId);}}
          onPointerMove={event=>{const current=drag.current;if(!current||current.id!==node.id)return;const dx=event.clientX-current.startX,dy=event.clientY-current.startY;if(Math.hypot(dx,dy)>5)current.moved=true;if(!current.moved)return;const updated={x:Math.max(nodeWidth/2/logicalWidth,Math.min(1-nodeWidth/2/logicalWidth,current.point.x+dx/logicalWidth)),y:Math.max(nodeHeight/2/logicalHeight,Math.min(1-nodeHeight/2/logicalHeight,current.point.y+dy/logicalHeight))};setLocal(value=>({...value,[node.id]:updated}));}}
          onPointerUp={()=>{const current=drag.current;if(current?.moved){suppress.current=true;const point=local[node.id];if(point)onMove(node.id,point);}drag.current=null;}}
          onPointerCancel={()=>{drag.current=null;}}><span className="atlas-node-dot"/><strong>{node.title}</strong><small>{atlasKinds[node.kind]}{node.status==='idea'?' · 构思':''}</small></button>;})}
      </div>
    </div>
    {relations.length>0&&<label className="atlas-field atlas-graph-relation-picker">查看连线<select aria-label="查看图谱关系" value="" onChange={event=>{const edge=relations.find(row=>row.id===event.target.value);if(edge)onInspectRelation(edge);}}><option value="">选择一条关系，编辑或查看来源</option>{relations.map(edge=><option key={edge.id} value={edge.id}>{nodes.find(node=>node.id===edge.fromId)?.title} {edge.symmetric?'↔':'→'} {nodes.find(node=>node.id===edge.toId)?.title} · {edge.label}</option>)}</select></label>}
    <p className="field-help">拖动卡片整理排布；Shift 点选可加入子图。虚线表示构思想法，箭头表示关系方向。<ArrowRight size={12}/></p>
  </div>;
}
