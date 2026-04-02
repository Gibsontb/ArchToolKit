window.CDK = window.CDK || {};
window.CDK.engine = window.CDK.engine || {};

window.CDK.engine.buildArchitecture = function(selectedServices) {
    const catalog = window.CDK.architecture.aws;

    const graph = {
        nodes: {},
        edges: []
    };

    function addNode(service, extra = {}) {
        if (!graph.nodes[service]) {
            graph.nodes[service] = {
                id: service,
                ...catalog[service],
                ...extra
            };
        }
    }

    function addEdge(from, to) {
        graph.edges.push({ from, to });
    }

    function ensureCoreNetwork() {
        addNode("vpc");

        addNode("public_subnet", { type: "public" });
        addNode("private_subnet", { type: "private" });

        addNode("igw");
        addNode("nat_gateway");

        addEdge("vpc", "public_subnet");
        addEdge("vpc", "private_subnet");

        addEdge("vpc", "igw");
        addEdge("public_subnet", "nat_gateway");
        addEdge("nat_gateway", "private_subnet");
    }

    function ensureALB() {
        if (!graph.nodes["alb"]) {
            addNode("alb");
            addEdge("public_subnet", "alb");
        }
    }

    function resolve(service) {
        const meta = catalog[service];
        if (!meta) return;

        addNode(service);

        // Dependencies
        if (meta.requires) {
            meta.requires.forEach(dep => {
                addNode(dep);
                addEdge(dep, service);
                resolve(dep);
            });
        }

        // Connections
        if (meta.connects_to) {
            meta.connects_to.forEach(target => {
                addNode(target);
                addEdge(service, target);
            });
        }
    }

    // 🔥 STEP 1 — ALWAYS CREATE BASE NETWORK
    ensureCoreNetwork();

    // 🔥 STEP 2 — RESOLVE USER SERVICES
    selectedServices.forEach(service => {
        resolve(service);
    });

    // 🔥 STEP 3 — SMART AWS RULES

    // EC2 → must be private
    if (graph.nodes["ec2"]) {
        addEdge("private_subnet", "ec2");
    }

    // RDS → must be private
    if (graph.nodes["rds"]) {
        addEdge("private_subnet", "rds");
    }

    // If EC2 exists → ensure ALB for public access
    if (graph.nodes["ec2"]) {
        ensureALB();
        addEdge("alb", "ec2");
    }

    // CloudFront → must have origin
    if (graph.nodes["cloudfront"]) {
        if (graph.nodes["alb"]) {
            addEdge("cloudfront", "alb");
        } else if (graph.nodes["s3"]) {
            addEdge("cloudfront", "s3");
        } else {
            // fallback: create ALB
            ensureALB();
            addEdge("cloudfront", "alb");
        }
    }

    // WAF attachment
    if (graph.nodes["waf"]) {
        if (graph.nodes["cloudfront"]) {
            addEdge("waf", "cloudfront");
        } else if (graph.nodes["alb"]) {
            addEdge("waf", "alb");
        }
    }

    // Route53 → points to edge or alb
    if (graph.nodes["route53"]) {
        if (graph.nodes["cloudfront"]) {
            addEdge("route53", "cloudfront");
        } else if (graph.nodes["alb"]) {
            addEdge("route53", "alb");
        }
    }

    return graph;
};