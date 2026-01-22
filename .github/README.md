# Polaris Music Registry - CI/CD Documentation

## Overview

This directory contains GitHub Actions workflows for continuous integration and deployment of the Polaris Music Registry project.

## Workflows

### 1. Backend CI (`backend-ci.yml`)

**Triggers**:
- Push to `main` or `develop` branches (backend changes)
- Pull requests targeting `main` or `develop` (backend changes)

**Jobs**:
- **Test**: Run unit and integration tests against Neo4j and Redis
  - Matrix strategy: Node.js 18.x and 20.x
  - Services: Neo4j 5.15, Redis 7-alpine
  - Coverage reporting to Codecov

- **Build**: Build Docker image for validation
  - Uses BuildKit cache for faster builds

**Environment Variables Required**:
- `NODE_ENV`: test
- `GRAPH_URI`: bolt://localhost:7687
- `GRAPH_USER`: neo4j
- `GRAPH_PASSWORD`: testpassword
- `REDIS_HOST`: localhost
- `REDIS_PORT`: 6379

### 2. Frontend CI (`frontend-ci.yml`)

**Triggers**:
- Push to `main` or `develop` branches (frontend changes)
- Pull requests targeting `main` or `develop` (frontend changes)

**Jobs**:
- **Test**: Run linter and tests
  - Matrix strategy: Node.js 18.x and 20.x
  - Build production bundle
  - Check bundle size (warns if >10MB)

- **Build**: Build Docker image for validation

### 3. Smart Contracts CI (`contracts-ci.yml`)

**Triggers**:
- Push to `main` or `develop` branches (contract changes)
- Pull requests targeting `main` or `develop` (contract changes)

**Jobs**:
- **Compile**: Compile contracts with EOSIO CDT 4.0.0
  - Generates WASM and ABI files
  - Uploads artifacts (7-day retention)

- **Test**: Run validation tests
  - Matrix strategy: Node.js 18.x and 20.x
  - Security audit with npm audit

- **Analyze**: Static analysis
  - clang-tidy for C++ code
  - Check for TODOs/FIXMEs

### 4. Docker Publish (`docker-publish.yml`)

**Triggers**:
- Push to `main` branch
- Version tags (v*.*.*)
- Manual workflow dispatch

**Jobs**:
- **Build and Push**: Build and push Docker images to GitHub Container Registry
  - Matrix: backend and frontend components
  - Tags: branch name, PR number, semver, SHA
  - Generates SBOMs (Software Bill of Materials)
  - 90-day SBOM retention

- **Scan**: Security scanning with Trivy
  - Uploads results to GitHub Security tab
  - Scans both backend and frontend images

**Registry**: `ghcr.io/<owner>/<repo>/<component>`

### 5. Kubernetes Deploy (`deploy.yml`)

**Triggers**:
- Manual workflow dispatch only (prevents accidental deployments)

**Inputs**:
- `environment`: development | staging | production
- `version`: Image tag to deploy (e.g., v1.0.0, sha-abc123)

**Jobs**:
- **Deploy**: Deploy to Kubernetes cluster
  - Configures kubectl with cluster credentials
  - Updates image tags with kustomize
  - Applies manifests
  - Waits for rollout completion
  - Runs smoke tests

**Required Secrets**:
- `KUBE_CONFIG`: Base64-encoded kubeconfig file

**Environments**:
Each environment should be configured in GitHub with:
- Protection rules
- Required reviewers
- Environment secrets

### 6. PR Checks (`pr-checks.yml`)

**Triggers**:
- All pull requests to `main` or `develop`

**Jobs**:
- **Changes**: Detect which components changed
  - Uses path filters to determine affected areas
  - Outputs: backend, frontend, contracts, k8s

- **Lint**: Run linters on changed components
  - Only runs for changed components
  - Fails if linting errors found

- **Security**: Security scanning
  - Semgrep static analysis
  - Dependency review (fails on moderate+ vulnerabilities)

- **Validate K8s**: Validate Kubernetes manifests
  - Only runs if k8s files changed
  - Validates with kubectl dry-run
  - Checks base and all overlays

- **PR Labeler**: Auto-label PRs based on changed files
  - Uses `.github/labeler.yml` configuration

- **Size Label**: Label PRs by size
  - xs: <10 lines
  - s: 10-100 lines
  - m: 100-500 lines
  - l: 500-1000 lines
  - xl: >1000 lines

### 7. Release (`release.yml`)

**Triggers**:
- Push tags matching `v*.*.*` (e.g., v1.0.0, v2.1.3)

**Jobs**:
- **Create Release**: Create GitHub release
  - Generates changelog from commit messages
  - Marks as prerelease if tag contains alpha/beta/rc

- **Build Contracts**: Compile and attach smart contracts
  - Creates tarball with WASM, ABI, and source
  - Uploads to release assets

- **Notify**: Send release notification
  - Outputs status to workflow logs

## Configuration Files

### Labeler (`labeler.yml`)

Automatically labels PRs based on changed files:
- `backend`: backend/**/*
- `frontend`: frontend/**/*
- `contracts`: contracts/**/*
- `infrastructure`: k8s/**, docker-compose.yml
- `documentation`: **/*.md
- `ci/cd`: .github/workflows/**/*
- `dependencies`: package.json, package-lock.json

### Dependabot (`dependabot.yml`)

Automated dependency updates:
- **npm** (backend, frontend, contracts/test): Weekly on Monday
- **GitHub Actions**: Monthly
- **Docker**: Weekly

**Labeling**:
- All updates labeled with `dependencies`
- Component-specific labels (backend, frontend, etc.)

**Commit Message Prefixes**:
- Backend: `chore(backend):`
- Frontend: `chore(frontend):`
- Contracts: `chore(contracts):`
- CI: `chore(ci):`

## Setup Instructions

### 1. Configure GitHub Secrets

Required repository secrets:

```bash
# Kubernetes deployment
KUBE_CONFIG=<base64-encoded kubeconfig>

# Docker registry (auto-configured for GHCR)
GITHUB_TOKEN=<auto-provided by GitHub>

# Optional: Codecov
CODECOV_TOKEN=<codecov token>
```

#### Generating KUBE_CONFIG

```bash
# Encode your kubeconfig
cat ~/.kube/config | base64 | pbcopy

# Add to GitHub:
# Settings > Secrets and variables > Actions > New repository secret
# Name: KUBE_CONFIG
# Value: <paste base64 content>
```

### 2. Configure Environments

Create three environments in GitHub:
- `development`
- `staging`
- `production`

**For each environment**:
1. Go to Settings > Environments > New environment
2. Add protection rules:
   - Required reviewers (for staging/production)
   - Wait timer (optional delay before deployment)
   - Deployment branches (restrict to specific branches)

### 3. Enable Workflows

Workflows are enabled by default. To configure:

1. Go to Actions tab
2. Select workflow from left sidebar
3. Click "..." menu > Settings
4. Configure as needed

### 4. Branch Protection Rules

Recommended rules for `main` branch:

```yaml
Require pull request before merging: ✓
  Require approvals: 1
  Dismiss stale reviews: ✓

Require status checks before merging: ✓
  Require branches to be up to date: ✓
  Status checks:
    - Backend CI / test
    - Frontend CI / test
    - Smart Contracts CI / compile
    - PR Checks / lint
    - PR Checks / security

Require conversation resolution: ✓
Do not allow bypassing the above settings: ✓
```

## Usage Examples

### Running CI Manually

Trigger workflow manually:
1. Go to Actions tab
2. Select workflow (e.g., "Backend CI")
3. Click "Run workflow"
4. Select branch
5. Click "Run workflow" button

### Deploying to Production

1. **Build and tag release**:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   This triggers the Release workflow.

2. **Deploy to Kubernetes**:
   - Go to Actions > "Deploy to Kubernetes"
   - Click "Run workflow"
   - Select inputs:
     - Environment: `production`
     - Version: `v1.0.0`
   - Click "Run workflow"

3. **Monitor deployment**:
   - Watch workflow progress in Actions tab
   - Check deployment logs
   - Verify smoke tests pass

### Creating a Pull Request

1. Create branch:
   ```bash
   git checkout -b feature/new-feature
   ```

2. Make changes and commit:
   ```bash
   git add .
   git commit -m "feat: add new feature"
   git push origin feature/new-feature
   ```

3. Open PR on GitHub
   - PR Checks workflow runs automatically
   - Auto-labeling applies component labels
   - Size label applied based on changes
   - Required checks must pass before merge

### Viewing Security Scan Results

1. Go to Security tab > Code scanning
2. View Trivy and Semgrep results
3. Filter by severity
4. Create issues for vulnerabilities

## Monitoring and Debugging

### Viewing Workflow Runs

```bash
# List recent runs
gh run list

# View specific run
gh run view <run-id>

# View logs
gh run view <run-id> --log

# Re-run failed jobs
gh run rerun <run-id> --failed
```

### Common Issues

#### **Workflow not triggering**

- Check path filters match your changes
- Verify branch name matches trigger configuration
- Check if workflow is disabled in Actions settings

#### **Tests failing in CI but passing locally**

- Check environment variables
- Verify service versions match (Neo4j, Redis, etc.)
- Review workflow logs for specific errors
- Run tests with same Node.js version as CI

#### **Docker build fails**

- Check Dockerfile syntax
- Verify build context includes required files
- Review BuildKit cache issues
- Check for missing dependencies

#### **Kubernetes deployment fails**

- Verify KUBE_CONFIG is valid and not expired
- Check cluster connectivity
- Review kubectl dry-run errors
- Verify image tags exist in registry

### Workflow Artifacts

Artifacts are stored for:
- **Compiled contracts**: 7 days
- **SBOMs**: 90 days
- **Coverage reports**: Uploaded to Codecov

Access artifacts:
1. Go to workflow run
2. Scroll to "Artifacts" section
3. Download artifact

## Best Practices

### Commit Messages

Follow Conventional Commits:
- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `chore:` Maintenance tasks
- `refactor:` Code refactoring
- `test:` Test changes
- `ci:` CI/CD changes

### Versioning

Use Semantic Versioning (semver):
- **Major** (v1.0.0 → v2.0.0): Breaking changes
- **Minor** (v1.0.0 → v1.1.0): New features, backwards compatible
- **Patch** (v1.0.0 → v1.0.1): Bug fixes

### Pull Request Size

Keep PRs small and focused:
- **xs/s**: Ideal size, easy to review
- **m**: Acceptable, but consider splitting
- **l/xl**: Too large, definitely split into smaller PRs

### Security

- Never commit secrets to repository
- Use GitHub Secrets for sensitive data
- Review Dependabot PRs promptly
- Monitor security scan results
- Keep dependencies up to date

## Cost Optimization

### GitHub Actions Minutes

Free tier: 2,000 minutes/month for private repos

**Optimization strategies**:
- Use path filters to skip unnecessary runs
- Cache dependencies (npm, Docker layers)
- Use matrix strategies efficiently
- Cancel redundant runs for force-pushes

### Storage

Free tier: 500MB for Actions artifacts and packages

**Optimization strategies**:
- Set appropriate retention periods
- Clean up old Docker images
- Remove unused artifacts

## Support

- **GitHub Actions**: https://docs.github.com/actions
- **Kubernetes**: https://kubernetes.io/docs/
- **Docker**: https://docs.docker.com/
- **EOSIO CDT**: https://github.com/AntelopeIO/cdt

For project-specific questions:
- GitHub Issues: https://github.com/<owner>/<repo>/issues
- Documentation: /docs/
