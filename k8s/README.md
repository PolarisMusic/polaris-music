# Polaris Music Registry - Kubernetes Deployment

This directory contains Kubernetes manifests for deploying the Polaris Music Registry to a production Kubernetes cluster.

## Architecture Overview

The deployment consists of the following components:

### Stateful Services (StatefulSets)
- **Neo4j**: Graph database (5.15-community) with APOC and GDS plugins
- **Redis**: Cache layer (7-alpine) with persistence
- **IPFS**: Decentralized storage node (kubo v0.24.0)
- **MinIO**: S3-compatible object storage

### Stateless Services (Deployments)
- **API Server**: Node.js/Express backend with GraphQL (3-10 replicas with HPA)
- **Event Processor**: Blockchain event indexer (1 replica)
- **Frontend**: Static web application (2-5 replicas with HPA)

### Network
- **Ingress**: NGINX ingress controller with TLS termination
- **Services**: ClusterIP services for internal communication

## Directory Structure

```
k8s/
├── base/                           # Base manifests (shared across environments)
│   ├── namespace.yaml              # Polaris namespace
│   ├── configmap.yaml              # Configuration values
│   ├── secret.yaml                 # Sensitive credentials (template)
│   ├── neo4j-statefulset.yaml      # Graph database
│   ├── redis-statefulset.yaml      # Cache layer
│   ├── ipfs-statefulset.yaml       # IPFS storage
│   ├── minio-statefulset.yaml      # S3-compatible storage
│   ├── api-deployment.yaml         # Backend API + HPA
│   ├── processor-deployment.yaml   # Event processor
│   ├── frontend-deployment.yaml    # Frontend + HPA
│   ├── ingress.yaml                # Ingress rules
│   └── kustomization.yaml          # Kustomize base config
│
├── overlays/
│   ├── development/                # Development overrides
│   │   ├── kustomization.yaml      # Dev-specific config
│   │   └── replicas-patch.yaml     # Lower replica counts
│   └── production/                 # Production overrides
│       ├── kustomization.yaml      # Prod-specific config
│       ├── replicas-patch.yaml     # Higher replica counts
│       └── resources-patch.yaml    # Increased resource limits
│
└── README.md                       # This file
```

## Prerequisites

### Required Tools
- `kubectl` (v1.27+)
- `kustomize` (v5.0+) or kubectl with built-in kustomize
- `helm` (v3.12+) for cert-manager installation

### Cluster Requirements
- Kubernetes v1.27 or newer
- Storage provisioner that supports dynamic PV provisioning
- Minimum 16 CPU cores and 64GB RAM across nodes
- LoadBalancer service support (for cloud providers) or MetalLB (for bare metal)

### External Dependencies
- **NGINX Ingress Controller**: For ingress traffic
- **cert-manager**: For automatic TLS certificate management
- **DNS**: Configured to point your domain to the cluster

## Initial Setup

### 1. Install Prerequisites

#### Install NGINX Ingress Controller
```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.9.4/deploy/static/provider/cloud/deploy.yaml
```

For bare metal clusters:
```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.9.4/deploy/static/provider/baremetal/deploy.yaml
```

#### Install cert-manager
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.2/cert-manager.yaml
```

Create Let's Encrypt ClusterIssuer:
```bash
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@polaris.music
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
```

### 2. Configure Secrets

**CRITICAL**: Update secret values before deploying to production!

```bash
# Generate secure random passwords
NEO4J_PASSWORD=$(openssl rand -base64 32)
MINIO_PASSWORD=$(openssl rand -base64 32)
S3_SECRET=$(openssl rand -base64 32)
REDIS_PASSWORD=$(openssl rand -base64 32)

# Create secret in Kubernetes
kubectl create secret generic polaris-secrets \
  --from-literal=NEO4J_AUTH="neo4j/${NEO4J_PASSWORD}" \
  --from-literal=GRAPH_PASSWORD="${NEO4J_PASSWORD}" \
  --from-literal=MINIO_ROOT_USER="polaris" \
  --from-literal=MINIO_ROOT_PASSWORD="${MINIO_PASSWORD}" \
  --from-literal=S3_ACCESS_KEY="polaris" \
  --from-literal=S3_SECRET_KEY="${S3_SECRET}" \
  --from-literal=REDIS_PASSWORD="${REDIS_PASSWORD}" \
  --namespace=polaris \
  --dry-run=client -o yaml > overlays/production/secrets.yaml

# Store passwords securely (e.g., in 1Password, Vault, etc.)
echo "NEO4J_PASSWORD: ${NEO4J_PASSWORD}" >> .secrets.txt
echo "MINIO_PASSWORD: ${MINIO_PASSWORD}" >> .secrets.txt
echo "S3_SECRET: ${S3_SECRET}" >> .secrets.txt
echo "REDIS_PASSWORD: ${REDIS_PASSWORD}" >> .secrets.txt
```

**Never commit `.secrets.txt` to version control!**

### 3. Update Configuration

Edit `base/configmap.yaml` to customize:
- Domain names (replace `polaris.music` with your domain)
- Blockchain RPC endpoint
- Resource limits based on your cluster capacity

Edit `base/ingress.yaml` to configure:
- Your domain names
- TLS certificate settings
- Rate limiting rules

## Deployment

### Development Environment

Deploy to a development cluster:

```bash
# Create namespace
kubectl create namespace polaris-dev

# Deploy all resources
kubectl apply -k overlays/development

# Watch deployment progress
kubectl get pods -n polaris-dev -w
```

### Production Environment

Deploy to production cluster:

```bash
# Create namespace
kubectl create namespace polaris

# Apply secrets (created in step 2)
kubectl apply -f overlays/production/secrets.yaml

# Deploy all resources
kubectl apply -k overlays/production

# Watch deployment progress
kubectl get pods -n polaris -w

# Check all resources
kubectl get all -n polaris
```

### Verify Deployment

```bash
# Check pod status
kubectl get pods -n polaris

# Check services
kubectl get svc -n polaris

# Check ingress
kubectl get ingress -n polaris

# Check persistent volumes
kubectl get pvc -n polaris

# View logs
kubectl logs -n polaris deployment/api -f
kubectl logs -n polaris deployment/processor -f
```

## Post-Deployment Configuration

### 1. Initialize Neo4j Schema

```bash
# Connect to API pod
kubectl exec -it -n polaris deployment/api -- /bin/sh

# Inside pod, run initialization
node -e "import('./src/graph/schema.js').then(m => new m.default(process.env).initializeSchema())"
```

### 2. Verify Services

```bash
# Test API health
curl https://api.polaris.music/health

# Test frontend
curl https://polaris.music

# Check Neo4j
kubectl port-forward -n polaris svc/neo4j 7474:7474
# Visit http://localhost:7474 in browser

# Check MinIO
kubectl port-forward -n polaris svc/minio 9001:9001
# Visit http://localhost:9001 in browser
```

### 3. Configure DNS

Point your domain to the ingress LoadBalancer IP:

```bash
# Get LoadBalancer IP
kubectl get svc -n ingress-nginx ingress-nginx-controller

# Create DNS A records:
# polaris.music        -> <LOADBALANCER_IP>
# www.polaris.music    -> <LOADBALANCER_IP>
# api.polaris.music    -> <LOADBALANCER_IP>
```

## Scaling

### Manual Scaling

```bash
# Scale API deployment
kubectl scale deployment api --replicas=5 -n polaris

# Scale frontend
kubectl scale deployment frontend --replicas=3 -n polaris
```

### Auto-Scaling

HorizontalPodAutoscalers are configured for:
- **API**: 3-10 replicas (CPU: 70%, Memory: 80%)
- **Frontend**: 2-5 replicas (CPU: 70%)

View autoscaler status:
```bash
kubectl get hpa -n polaris
```

### Resource Limits

Production resource allocation:

| Service | Requests | Limits |
|---------|----------|--------|
| Neo4j | 1 CPU, 4Gi | 2 CPU, 8Gi |
| Redis | 250m CPU, 1Gi | 500m CPU, 2Gi |
| IPFS | 500m CPU, 2Gi | 1 CPU, 4Gi |
| MinIO | 500m CPU, 2Gi | 1 CPU, 4Gi |
| API (per pod) | 500m CPU, 1Gi | 1 CPU, 2Gi |
| Processor | 500m CPU, 1Gi | 1 CPU, 2Gi |
| Frontend (per pod) | 100m CPU, 128Mi | 200m CPU, 256Mi |

## Storage

### Persistent Volumes

| Service | Volume | Size | Purpose |
|---------|--------|------|---------|
| Neo4j | neo4j-data | 50Gi | Graph database |
| Neo4j | neo4j-logs | 10Gi | Database logs |
| Neo4j | neo4j-import | 20Gi | Import staging |
| Neo4j | neo4j-plugins | 5Gi | APOC/GDS plugins |
| Redis | redis-data | 10Gi | Cache persistence |
| IPFS | ipfs-data | 100Gi | IPFS blocks |
| IPFS | ipfs-staging | 50Gi | Import staging |
| MinIO | minio-data | 200Gi | S3 objects |

**Total Storage**: ~465Gi

### Backup Strategy

```bash
# Backup Neo4j
kubectl exec -n polaris neo4j-0 -- neo4j-admin dump --to=/tmp/backup.dump
kubectl cp polaris/neo4j-0:/tmp/backup.dump ./neo4j-backup-$(date +%Y%m%d).dump

# Backup MinIO (using mc client)
kubectl port-forward -n polaris svc/minio 9000:9000
mc mirror polaris/polaris-events ./minio-backup-$(date +%Y%m%d)/
```

## Monitoring

### View Logs

```bash
# API logs
kubectl logs -n polaris -l app=api -f

# Processor logs
kubectl logs -n polaris -l app=processor -f

# Neo4j logs
kubectl logs -n polaris -l app=neo4j -f

# All logs from namespace
kubectl logs -n polaris --all-containers -f
```

### Metrics

```bash
# Pod resource usage
kubectl top pods -n polaris

# Node resource usage
kubectl top nodes

# Detailed pod description
kubectl describe pod -n polaris <pod-name>
```

### Common Issues

#### Pod CrashLoopBackOff
```bash
# Check pod logs
kubectl logs -n polaris <pod-name>

# Check events
kubectl get events -n polaris --sort-by='.lastTimestamp'

# Describe pod for detailed info
kubectl describe pod -n polaris <pod-name>
```

#### Storage Issues
```bash
# Check PVC status
kubectl get pvc -n polaris

# Check PV status
kubectl get pv

# Describe PVC
kubectl describe pvc -n polaris <pvc-name>
```

#### Network Issues
```bash
# Test internal DNS
kubectl run -it --rm debug --image=busybox --restart=Never -- nslookup neo4j.polaris.svc.cluster.local

# Test service connectivity
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- curl http://api.polaris:3000/health
```

## Updates and Rollouts

### Update Application Images

```bash
# Update image tag in overlays/production/kustomization.yaml
# Then apply changes

kubectl apply -k overlays/production

# Watch rollout
kubectl rollout status deployment/api -n polaris

# Rollback if needed
kubectl rollout undo deployment/api -n polaris
```

### Rolling Update Strategy

Deployments use rolling updates by default:
- MaxUnavailable: 25%
- MaxSurge: 25%

This ensures zero-downtime deployments.

### Database Migrations

```bash
# Connect to API pod
kubectl exec -it -n polaris deployment/api -- /bin/sh

# Run migrations
npm run migrate
```

## Security

### Network Policies

Consider adding NetworkPolicies to restrict pod-to-pod communication:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-network-policy
  namespace: polaris
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ingress-nginx
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: neo4j
  - to:
    - podSelector:
        matchLabels:
          app: redis
```

### Pod Security

All pods run as non-root users when possible. Consider enforcing with PodSecurityPolicies or Pod Security Standards.

### Secrets Management

For production, consider using external secret managers:
- **HashiCorp Vault**
- **AWS Secrets Manager**
- **Azure Key Vault**
- **Google Secret Manager**

Integration example with External Secrets Operator:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: polaris-secrets
  namespace: polaris
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: polaris-secrets
  data:
  - secretKey: NEO4J_AUTH
    remoteRef:
      key: polaris/neo4j
      property: auth
```

## Cost Optimization

### Resource Requests

Tune resource requests based on actual usage:

```bash
# Monitor actual usage over time
kubectl top pods -n polaris --containers

# Adjust requests in overlays/production/resources-patch.yaml
```

### Storage Classes

Use appropriate storage classes:
- **SSD**: For Neo4j data (high IOPS)
- **Standard**: For logs and backups
- **Archive**: For long-term backups

### Auto-Scaling

Configure cluster autoscaling to match demand:
- Scale down during low-traffic periods
- Scale up during peak times

## Disaster Recovery

### Backup Schedule

Recommended backup schedule:
- **Neo4j**: Daily full backup, hourly incrementals
- **MinIO**: Continuous replication to secondary bucket
- **IPFS**: Data is content-addressed and distributed
- **Redis**: Snapshots every 6 hours

### Recovery Procedure

1. **Restore Neo4j**:
```bash
kubectl exec -n polaris neo4j-0 -- neo4j-admin load --from=/tmp/backup.dump
```

2. **Restore MinIO**:
```bash
mc mirror ./minio-backup/ polaris/polaris-events
```

3. **Rebuild IPFS**:
IPFS data can be re-fetched from network using content hashes.

## Production Checklist

Before going live:

- [ ] Update all passwords in secrets
- [ ] Configure proper domain names
- [ ] Set up TLS certificates
- [ ] Configure DNS records
- [ ] Set up monitoring and alerting
- [ ] Configure backup automation
- [ ] Test disaster recovery procedure
- [ ] Review and adjust resource limits
- [ ] Configure autoscaling thresholds
- [ ] Set up log aggregation
- [ ] Enable network policies
- [ ] Audit security settings
- [ ] Load test the deployment
- [ ] Document runbook procedures

## Support

For issues and questions:
- GitHub Issues: https://github.com/polaris/music-registry/issues
- Documentation: https://docs.polaris.music
- Discord: https://discord.gg/polaris

## License

MIT License - see LICENSE file for details
