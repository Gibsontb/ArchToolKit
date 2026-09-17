window.CDK = window.CDK || {};
window.CDK.renderer = window.CDK.renderer || {};

window.CDK.renderer.renderArchitecture = function renderArchitecture(graph, containerId) {
  var container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!container) return;

  var order = ['edge', 'dns', 'network', 'load_balancer', 'compute', 'database', 'storage', 'security', 'monitoring', 'other'];
  var titles = {
    edge: 'Edge',
    dns: 'DNS',
    network: 'Network',
    load_balancer: 'Load Balancer',
    compute: 'Compute',
    database: 'Database',
    storage: 'Storage',
    security: 'Security',
    monitoring: 'Monitoring',
    other: 'Other'
  };

  function pretty(text) {
    return String(text || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (m) { return m.toUpperCase(); });
  }

  function laneFor(node) {
    var c = (node && node.category) || 'other';
    if (c === 'load_balancer') return 'load_balancer';
    if (titles[c]) return c;
    return 'other';
  }

  var grouped = {};
  order.forEach(function (key) { grouped[key] = []; });

  Object.keys(graph.nodes || {}).forEach(function (id) {
    var node = graph.nodes[id] || {};
    grouped[laneFor(node)].push({ id: id, node: node });
  });

  var board = order
    .filter(function (lane) { return grouped[lane].length; })
    .map(function (lane) {
      var cards = grouped[lane]
        .sort(function (a, b) { return a.id.localeCompare(b.id); })
        .map(function (entry) {
          var node = entry.node || {};
          var meta = [];
          if (node.placement) meta.push('placement: ' + node.placement);
          if (node.exposure) meta.push('exposure: ' + node.exposure);
          if (node.scope) meta.push('scope: ' + node.scope);
          if (node.subnet_type) meta.push('subnet: ' + node.subnet_type);
          if (node.global) meta.push('global');
          if (node.layer) meta.push('layer ' + node.layer);
          if (node.multi_az_supported) meta.push('multi-AZ supported');

          return (
            '<div class="card">' +
              '<div class="name">' + pretty(entry.id) + '</div>' +
              '<div class="meta">' + (meta.join(' · ') || 'inferred by engine') + '</div>' +
            '</div>'
          );
        })
        .join('');

      return (
        '<div class="lane">' +
          '<h3>' + titles[lane] + '</h3>' +
          cards +
        '</div>'
      );
    })
    .join('');

  var edges = (graph.edges || [])
    .map(function (edge) {
      return '<span class="edge">' + pretty(edge.from) + ' → ' + pretty(edge.to) + '</span>';
    })
    .join('');

  container.innerHTML =
    (board
      ? '<div class="board">' + board + '</div>'
      : '<div class="empty">No topology to render.</div>') +
    '<div class="edges">' +
      '<h3>Resolved Connections</h3>' +
      '<div class="edge-list">' + (edges || '<span class="edge">No edges</span>') + '</div>' +
    '</div>';
};
