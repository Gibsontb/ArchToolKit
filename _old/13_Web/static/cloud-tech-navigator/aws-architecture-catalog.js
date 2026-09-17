window.CDK = window.CDK || {};
window.CDK.architecture = window.CDK.architecture || {};
window.CDK.architecture.aws = {
  "vpc": {
    "category": "network",
    "is_root": true,
    "creates": [
      "subnet",
      "route_table",
      "igw",
      "nat_gateway"
    ],
    "scope": "regional"
  },
  "public_subnet": {
    "category": "network",
    "requires": [
      "vpc"
    ],
    "subnet_type": "public",
    "connects_to": [
      "alb",
      "nat_gateway",
      "igw"
    ]
  },
  "private_subnet": {
    "category": "network",
    "requires": [
      "vpc"
    ],
    "subnet_type": "private",
    "connects_to": [
      "ec2",
      "rds",
      "route_table",
      "nat_gateway"
    ]
  },
  "subnet": {
    "category": "network",
    "requires": [
      "vpc"
    ],
    "types": [
      "public",
      "private"
    ],
    "connects_to": [
      "ec2",
      "alb",
      "rds"
    ]
  },
  "igw": {
    "category": "network",
    "requires": [
      "vpc"
    ],
    "exposure": "public"
  },
  "nat_gateway": {
    "category": "network",
    "requires": [
      "vpc",
      "public_subnet"
    ],
    "connects_to": [
      "private_subnet"
    ]
  },
  "route_table": {
    "category": "network",
    "requires": [
      "vpc"
    ],
    "connects_to": [
      "subnet"
    ]
  },
  "security_group": {
    "category": "security",
    "requires": [
      "vpc"
    ],
    "attaches_to": [
      "ec2",
      "alb",
      "rds"
    ]
  },
  "alb": {
    "category": "load_balancer",
    "requires": [
      "vpc",
      "public_subnet",
      "security_group"
    ],
    "connects_to": [
      "ec2"
    ],
    "exposure": "public",
    "layer": "7"
  },
  "ec2": {
    "category": "compute",
    "requires": [
      "vpc",
      "private_subnet",
      "security_group"
    ],
    "connects_to": [
      "rds",
      "alb",
      "s3",
      "cloudwatch",
      "secrets_manager"
    ],
    "placement": "private",
    "scalable": true
  },
  "autoscaling_group": {
    "category": "compute",
    "requires": [
      "ec2"
    ],
    "connects_to": [
      "alb"
    ]
  },
  "launch_template": {
    "category": "compute",
    "requires": [
      "ec2"
    ]
  },
  "rds": {
    "category": "database",
    "requires": [
      "vpc",
      "private_subnet",
      "security_group"
    ],
    "connects_to": [
      "ec2",
      "secrets_manager",
      "cloudwatch"
    ],
    "placement": "private",
    "multi_az_supported": true
  },
  "aurora": {
    "category": "database",
    "requires": [
      "vpc",
      "private_subnet",
      "security_group"
    ],
    "connects_to": [
      "ec2",
      "secrets_manager",
      "cloudwatch"
    ],
    "placement": "private",
    "multi_az_supported": true
  },
  "s3": {
    "category": "storage",
    "global": true,
    "connects_to": [
      "cloudfront",
      "ec2"
    ]
  },
  "cloudfront": {
    "category": "edge",
    "requires": [
      "origin"
    ],
    "valid_origins": [
      "alb",
      "s3"
    ],
    "global": true
  },
  "waf": {
    "category": "security",
    "attaches_to": [
      "cloudfront",
      "alb"
    ]
  },
  "acm": {
    "category": "security",
    "provides": [
      "ssl_certificate"
    ],
    "attaches_to": [
      "cloudfront",
      "alb"
    ]
  },
  "route53": {
    "category": "dns",
    "requires": [
      "domain"
    ],
    "connects_to": [
      "cloudfront",
      "alb"
    ],
    "global": true
  },
  "iam_role": {
    "category": "security",
    "attaches_to": [
      "ec2",
      "lambda",
      "rds"
    ]
  },
  "secrets_manager": {
    "category": "security",
    "connects_to": [
      "ec2",
      "rds",
      "aurora"
    ]
  },
  "cloudwatch": {
    "category": "monitoring",
    "connects_to": [
      "ec2",
      "alb",
      "rds",
      "aurora"
    ]
  }
};
