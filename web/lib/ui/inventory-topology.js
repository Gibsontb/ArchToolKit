                                                        
import { inventoryTopology, inventoryTopologyOverview,                   } from '../vmware/inventory-topology.js';
import { el, replace, downloadFile } from './dom.js';
import { card, field, select, table } from './components.js';
export function mountInventoryTopology(root             , inventory           )       {
  const center = select([{ value: '', label: 'All vCenters' }, ...[...new Set([...(inventory.vcenters??[]).map(center=>center.name),...inventory.hosts.map(host => host.vcenter ?? '')].filter(Boolean))].sort().map(value => ({ value, label: value }))], '');
  const cluster = select([{value:'',label:'All clusters'}],'');
  const hostSelect = select([{value:'',label:'All hosts (summary)'}],'');
  const network = select([{ value: '', label: 'All networks on this host' }], '');
  const content = el('div'); let offset = 0;
  const clusterKey = (host                            ) => JSON.stringify([host.vcenter??'',host.cluster??'']);
  function clusters(selected = '')       {
    const choices = new Map               ();
    for(const host of inventory.hosts)if(!center.value || host.vcenter===center.value)choices.set(clusterKey(host),(host.cluster||'Unclustered hosts')+(!center.value&&host.vcenter?' · '+host.vcenter:''));
    cluster.replaceChildren(el('option',{text:'All clusters',attrs:{value:''}}), ...[...choices].sort((a,b)=>a[1].localeCompare(b[1])).map(([value,label])=>el('option',{text:label,attrs:{value}})));
    cluster.value = choices.has(selected)?selected:'';
    hosts();
  }
  function hosts()       {
    hostSelect.replaceChildren(el('option',{text:'All hosts (summary)',attrs:{value:''}}),...inventory.hosts.map((host,index)=>({host,index})).filter(({host})=>(!center.value||host.vcenter===center.value)&&(!cluster.value||clusterKey(host)===cluster.value)).map(({host,index})=>el('option',{text:host.name,attrs:{value:index}})));
    hostSelect.value='';networks();
  }
  function selectedHost()                     {
    if(hostSelect.value==='')return undefined;
    const index=Number(hostSelect.value);return Number.isInteger(index)&&inventory.hosts[index]?index:undefined;
  }
  function networks()       {
    const index=selectedHost();const host=index===undefined?undefined:inventory.hosts[index];
    const names = host ? [...new Set([
      ...inventory.vms.filter(vm => vm.host === host.name && (vm.vcenter ?? '') === (host.vcenter ?? '')).flatMap(vm => (vm.nics ?? []).map(nic => nic.network ?? '')),
      ...(host.vmkernelAdapters ?? []).map(nic => nic.portGroup ?? ''),
    ].filter(Boolean))].sort() : [];
    network.replaceChildren(el('option', { text: host?'All networks on this host':'Select a host to filter networks', attrs: { value: '' } }), ...names.map(name => el('option', { text: name, attrs: { value: name } })));
    network.value='';network.disabled=!host;
    offset = 0; draw();
  }
  function drill(node              )       {
    if(node.hostIndex!==undefined){hostSelect.value=String(node.hostIndex);networks();return;}
    if(node.vcenter!==undefined){center.value=node.vcenter;clusters(node.clusterKey??'');}
  }
  function draw()       {
    const hostIndex=selectedHost();
    const overview=inventoryTopologyOverview(inventory,center.value,cluster.value);
    const graph=hostIndex===undefined?overview:inventoryTopology(inventory,hostIndex,network.value,offset);
    if (!graph.nodes.length) { replace(content, el('p', { text: 'No hosts are available in the selected scope.' })); return; }
    const ns = 'http://www.w3.org/2000/svg';
    const make =                                       (tag   , attrs                       , text         )                          => {
      const node = document.createElementNS(ns, tag); for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,value); if (text) node.textContent = text; return node;
    };
    const counts = [0,0,0,0]; const positions = new Map                            ();
    for (const node of graph.nodes) positions.set(node.id, { x: 20 + node.column * 300, y: 50 + counts[node.column] ++ * 86 });
    const height = Math.max(250, ...counts.map(count => count * 86 + 80));
    const svg = make('svg', { viewBox: '0 0 1200 ' + height, width: '1200', height: String(height), role: 'img', 'aria-label': hostIndex===undefined?'Estate topology overview':'Recorded virtual network topology for the selected host' });
    for (const edge of graph.edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) continue;
      const path = make('path', { d: 'M ' + (from.x + 260) + ' ' + (from.y + 25) + ' C ' + (from.x + 280) + ' ' + (from.y + 25) + ', ' + (to.x - 20) + ' ' + (to.y + 25) + ', ' + to.x + ' ' + (to.y + 25), stroke: '#8b9bb4', fill: 'none', 'stroke-width': '1.5' });
      path.appendChild(make('title', {}, edge.relationship)); svg.appendChild(path);
    }
    for (const node of graph.nodes) {
      const point = positions.get(node.id) ; const group = make('g', {});
      if(node.hostIndex!==undefined||node.vcenter!==undefined){
        group.setAttribute('role','button');group.setAttribute('tabindex','0');group.setAttribute('aria-label','Expand '+node.label);group.style.cursor='pointer';
        group.addEventListener('click',()=>drill(node));
        group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();drill(node);}});
      }
      group.appendChild(make('rect', { x: String(point.x), y: String(point.y), width: '260', height: '64', rx: '7', fill: node.kind === 'Host' ? '#e8edff' : '#f5f7fa', stroke: '#bac6d8' }));
      group.appendChild(make('title', {}, node.kind + ' · ' + node.label + '\n' + node.detail));
      group.appendChild(make('text', { x: String(point.x+10), y: String(point.y+20), fill: '#14243f', 'font-family': 'system-ui,sans-serif', 'font-size': '12' }, node.label.length > 34 ? node.label.slice(0,31) + '…' : node.label));
      group.appendChild(make('text', { x: String(point.x+10), y: String(point.y+43), fill: '#52627c', 'font-family': 'system-ui,sans-serif', 'font-size': '10' }, node.detail.length > 42 ? node.detail.slice(0,39) + '…' : node.detail || node.kind));
      svg.appendChild(group);
    }
    const previous = el('button', { class: 'btn', text: 'Previous connections', attrs: { type: 'button', disabled: offset === 0 }, on: { click: () => { offset = Math.max(0,offset-40);draw(); } } });
    const next = el('button', { class: 'btn', text: 'Next connections', attrs: { type: 'button', disabled: offset+40>=graph.total }, on: { click: () => { offset+=40;draw(); } } });
    replace(content, el('p', { attrs: { 'data-control':'topology-scope-summary',role:'status' }, text: hostIndex===undefined?overview.vcenters+' vCenters · '+overview.clusters+' clusters'+(overview.hostGroups>overview.clusters?' · '+(overview.hostGroups-overview.clusters)+' unclustered host groups':'')+' · '+overview.total+' hosts. Select a node to expand its connections.':graph.shown + ' of ' + graph.total + ' VM NIC / VMkernel connections shown. Hover a node for full details.' }),
      el('div', { class: 'btn-row' }, hostIndex===undefined?null:previous,hostIndex===undefined?null:next,
        el('button', { class: 'btn', text: 'Download topology SVG', attrs: { type: 'button' }, on: { click: () => downloadFile('network-topology.svg', new XMLSerializer().serializeToString(svg),'image/svg+xml') } }),
        el('button', { class: 'btn', text: 'Download topology JSON', attrs: { type: 'button' }, on: { click: () => downloadFile('network-topology.json', JSON.stringify(graph,null,2)) } })),
      el('div', { class: 'table-wrap' }, svg),
      table([{ header: 'Node', render: node => node.label },{ header: 'Type',render: node => node.kind },{ header: 'Details',render: node => node.detail }],graph.nodes));
  }
  center.addEventListener('change',()=>clusters()); cluster.addEventListener('change',hosts);hostSelect.addEventListener('change',networks); network.addEventListener('change',()=>{offset=0;draw();});
  replace(root,card('Build topology', el('p', { class: 'muted', text: 'Recorded host, virtual-switch, port-group and adapter relationships. Physical upstream switches, routes and firewall paths require additional discovery.' }),
    el('div', { class: 'field-grid' },field('vCenter',center),field('Cluster',cluster),field('Host',hostSelect),field('Network',network)),
    el('button',{class:'btn btn-primary',text:'Build topology',attrs:{type:'button'},on:{click:()=>{offset=0;draw();}}}),content));
  clusters();
}
