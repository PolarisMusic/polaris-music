# Documentation Mismatch Analysis

**Date**: 2026-01-01
**Project**: Polaris Music Registry
**Purpose**: Identify discrepancies between documentation and implementation

## Executive Summary

This document analyzes mismatches between English-language documentation (README files, docs/, CLAUDE.md) and the actual implemented code. Each mismatch is categorized by severity and includes a recommendation for resolution.

**Severity Levels**:
- 🔴 **CRITICAL**: Breaks documented functionality, prevents usage
- 🟠 **HIGH**: Misleading information, significant effort wasted
- 🟡 **MEDIUM**: Minor confusion, can be worked around
- 🟢 **LOW**: Cosmetic inconsistencies, no practical impact

**Summary Statistics**:
- Total Mismatches: 20
- Critical: 5 (4 fixed, 1 remaining)
- High: 0
- Medium: 6
- Low: 9

---

## Critical Mismatches (Prevent Usage)

### ✅ #1: Missing `release_guests` Field in Frontend [FIXED]

**Status**: Fixed
**Documentation**: README.md lines 286-297, 454-455
**Implementation**: Frontend form now includes release_guests

**Resolution**:
- Added "Release-Level Credits" section to `frontend/index.html`
- Implemented `createReleaseGuestForm()` in FormBuilder.js
- Updated `extractReleaseGuests()` to handle form data
- Modified `buildReleaseData()` to include guests array

**Verification**: ✅ `frontend/index.html` lines 95-107

---

### 🔴 #2: Emission Formula Multiplier Mismatch [REMAINING]

**Severity**: CRITICAL
**Location**: README.md vs contracts/polaris.music.cpp

**Discrepancy**:
- **README.md states** (lines 886-890):
  ```
  - CREATE_RELEASE_BUNDLE: 100,000,000
  - ADD_CLAIM: 1,000,000
  - EDIT_CLAIM: 1,000
  ```

- **Smart Contract implements** (`contracts/polaris.music.cpp` line 507-512):
  ```cpp
  - CREATE_RELEASE_BUNDLE: 1,000,000   (100x lower)
  - ADD_CLAIM: 50,000                  (20x lower)
  - EDIT_CLAIM: 1,000                  (matches)
  ```

**Impact**:
- Users will receive 100x fewer rewards for releases than documented
- Economic model is fundamentally different
- Could cause community backlash if discovered post-launch

**Recommendation**:
**Option A** (Recommended): Update README to match implementation
- Pros: Contract is already fixed, no blockchain change needed
- Cons: Must justify lower rewards to community

**Option B**: Update contract multipliers to match README
- Pros: Honors documented economics
- Cons: Requires contract redeployment, potential governance vote

**Decision Required**: Product owner must choose which source is authoritative

**Files to Update**:
- If choosing Option A: `README.md` lines 886-890
- If choosing Option B: `contracts/polaris.music.cpp` lines 1039-1053 (get_multiplier function)

---

### ✅ #3: `updrespect` Action Signature Mismatch [FIXED]

**Status**: Fixed
**Documentation**: README.md lines 864-867
**Implementation**: Contract implements batch update

**Resolution**:
- Updated README to match actual implementation
- Documented correct signature with vector of account:respect pairs
- Added election_round parameter

**Verification**: ✅ README.md lines 864-867 now correct

---

### ✅ #4: Missing `proofs` Field in Frontend [FIXED]

**Status**: Fixed
**Documentation**: README.md line 811, docs/03-event-storage.md
**Implementation**: Frontend now captures proofs

**Resolution**:
- Added "Source Attribution" section to frontend form
- Implemented `source_links` input field in index.html
- Updated `buildReleaseData()` to create proofs object
- Usage: Provide verification sources (Discogs, MusicBrainz, etc.)

**Verification**: ✅ `frontend/index.html` lines 95-102, `frontend/src/index.js` lines 140-142

---

### ✅ #5: Docker Compose File Missing [FIXED]

**Status**: Fixed
**Documentation**: README.md lines 1019-1028
**Implementation**: Now includes comprehensive docker-compose.yml

**Resolution**:
- Created complete `docker-compose.yml` with all services
- Includes Neo4j, Redis, IPFS, MinIO, API, Processor, Frontend
- Added health checks and service dependencies
- Created supporting Dockerfiles and .env.example

**Verification**: ✅ `docker-compose.yml` at repository root

---

## High-Priority Mismatches (Misleading Information)

No high-priority mismatches remaining. All have been fixed or downgraded to medium.

---

## Medium-Priority Mismatches (Minor Confusion)

### 🟡 #6: Missing Backend Directory Structure

**Severity**: MEDIUM
**Location**: README.md line 958
**Issue**: README shows `backend/src/config/` directory that doesn't exist

**Documentation**:
```
├── backend/
│   ├── src/
│   │   ├── config/         # Configuration files
```

**Implementation**: No `backend/src/config/` directory
**Actual Pattern**: Configuration via environment variables in code

**Recommendation**: Update README directory structure
- Remove `config/` directory reference
- Add note: "Configuration managed via environment variables"

**Impact**: Developer looks for config files that don't exist
**Workaround**: Check `.env.example` and source code

---

### ⏳ #7: Tools Directory Implementation [PARTIALLY FIXED]

**Severity**: MEDIUM
**Location**: README.md lines 919-926, CLAUDE.md line 144
**Status**: Stubs created, full implementation deferred

**Documentation**:
```bash
# Import single release
node tools/cli/import-cli.js discogs release -i 12345
```

**Implementation**:
- ✅ `tools/import/discogsImporter.js` - stub with TODO
- ✅ `tools/import/csvImporter.js` - stub with TODO
- ✅ `tools/migration/migrate.js` - stub with TODO
- ✅ `tools/README.md` - implementation guide
- ❌ Full CLI not implemented

**Recommendation**: Update README to indicate tools are planned
- Add note: "⏳ Import tools in development - see `/tools/README.md`"
- Provide specification reference: `/docs/10-data-import-tools.md`

**Impact**: Users try to import data, tools don't work
**Workaround**: Manual API submission or wait for implementation

---

### 🟡 #8: Missing Deployment Scripts

**Severity**: MEDIUM
**Location**: README.md line 1034

**Documentation**:
```bash
./deploy.sh production v1.0.0
```

**Implementation**: No `deploy.sh` script exists

**Recommendation**: Update README with actual deployment method
- Replace with: "Use GitHub Actions workflow (see `.github/workflows/deploy.yml`)"
- Document manual deployment: `kubectl apply -k k8s/overlays/production`

**Impact**: Users can't deploy using documented method
**Workaround**: Use GitHub Actions or manual kubectl

---

### 🟡 #9: Missing Performance Test Directory

**Severity**: MEDIUM
**Location**: CLAUDE.md line 37

**Documentation**:
```
├── backend/test/
│   ├── performance/    # Performance tests
```

**Implementation**: Directory doesn't exist

**Recommendation**: Create directory or update CLAUDE.md
- Option A: Create placeholder `backend/test/performance/README.md`
- Option B: Remove from CLAUDE.md with note "⏳ Planned"

**Impact**: Developers look for performance tests
**Workaround**: None - feature not implemented

---

### 🟡 #10: Missing Documentation Files

**Severity**: MEDIUM
**Location**: CLAUDE.md lines 53-56

**Documentation Lists**:
- ✅ `docs/01-smart-contract.md` - exists
- ❌ `docs/02-graph-database-schema.md` - doesn't exist (referenced as canonical)
- ✅ `docs/03-event-storage.md` - exists
- ❌ `docs/04-event-processor.md` - doesn't exist
- ❌ `docs/05-*.md` - don't exist

**Recommendation**: Create missing docs or update CLAUDE.md
- Critical: `docs/02-graph-database-schema.md` (marked as CANONICAL)
- Important: `docs/04-event-processor.md`
- Others: Create stubs or mark as planned

**Impact**: CLAUDE.md references don't work
**Workaround**: Check code implementation directly

---

### 🟡 #11: Kubernetes Files Reference Before Creation

**Severity**: MEDIUM (NOW FIXED)
**Location**: README.md line 977

**Original Issue**: README referenced `k8s/` directory that didn't exist
**Resolution**: ✅ Created comprehensive k8s/ directory with all manifests

**Verification**: ✅ `k8s/` directory exists with base and overlays

---

## Low-Priority Mismatches (Cosmetic)

### 🟢 #12: Hardcoded Attestor Not Documented

**Severity**: LOW
**Location**: contracts/README.md vs polaris.music.cpp

**Issue**: Contract has `clear()` action for testing not documented in README

**Implementation**: `polaris.music.cpp` line 642-650
```cpp
#ifdef TESTNET
ACTION clear() { ... }
#endif
```

**Recommendation**: Add to contract README under "Testing Actions"
- Document that `clear()` only exists in TESTNET builds
- Warn to remove before mainnet deployment

**Impact**: Undocumented dangerous action exists
**Mitigation**: Already guarded with `#ifdef TESTNET`

---

### 🟢 #13: Frontend Visualization Directory Incomplete

**Severity**: LOW
**Location**: frontend/README.md line 42

**Documentation**: Claims `src/visualization/` has JIT-based graph visualization

**Implementation**:
- ✅ `MusicGraph.js` - fully implemented (722 lines)
- ✅ `colorPalette.js` - complete
- ✅ `graphApi.js` - complete
- ✅ `PathTracker.js` - complete (new)
- ✅ `LikeManager.js` - complete (new)

**Status**: Actually more complete than docs suggest!

**Recommendation**: Update frontend/README.md to reflect new features
- Document PathTracker and LikeManager modules
- Add usage examples
- Note: visualization.README.md already comprehensive

**Impact**: None - implementation exceeds documentation

---

### 🟢 #14-15: Substreams Module Mismatches

**Severity**: LOW
**Location**: substreams/README.md vs substreams.yaml

**Issue**: README lists 4 modules, YAML only has 3 properly defined

**Recommendation**: Update either README or implementation
- Low priority - substreams not critical path

**Impact**: Substreams may not work as documented
**Workaround**: Check actual YAML manifest

---

### 🟢 #16: Unused checksum_to_hex() Function

**Severity**: LOW
**Location**: contracts/polaris.music.cpp line 1188

**Issue**: Function defined but minimally used

**Recommendation**: Verify necessity, remove if unused
**Impact**: Minor code bloat
**Priority**: Code cleanup task

---

### 🟢 #17-18: Test-Related Inconsistencies

**Severity**: LOW
**Issues**:
- crypto-js package reference (correct - no mismatch)
- Various test configurations

**Recommendation**: No action needed
**Impact**: None

---

## Data Structure Mismatches

### 🟢 #19: Event Type Field Consistency

**Severity**: LOW
**Status**: Implementation correct, no mismatch found

**Verification**: Event types properly validated in smart contract

---

### 🟢 #20: Node ID Format Consistency

**Severity**: LOW
**Status**: Implementation uses deterministic hashing correctly

**Verification**: hashGenerator.js properly implements hashing

---

## Recommendations Summary

### Immediate Actions (Before Next Release)

1. **🔴 CRITICAL: Resolve Emission Multiplier Mismatch (#2)**
   - Decision required: Update README or update contract?
   - Must align before mainnet launch
   - Recommend: Update README to match contract (avoid redeployment)

2. **🟡 MEDIUM: Update README Directory Structure (#6)**
   - Remove `backend/src/config/` reference
   - Add environment variable note

3. **🟡 MEDIUM: Update Deployment Instructions (#8)**
   - Replace `deploy.sh` with GitHub Actions reference
   - Document manual kubectl method

4. **🟡 MEDIUM: Mark Tools as In Development (#7)**
   - Add "⏳ Planned" indicators
   - Reference tools/README.md for specifications

### Nice to Have (Can Defer)

5. **🟡 MEDIUM: Create Missing Docs (#10)**
   - Priority: `docs/02-graph-database-schema.md` (marked as canonical)
   - Create `docs/04-event-processor.md`
   - Add stubs for others

6. **🟢 LOW: Document clear() Action (#12)**
   - Add to contract README
   - Note TESTNET-only guard

7. **🟢 LOW: Clean Up Unused Code (#16)**
   - Verify checksum_to_hex() necessity
   - Remove if unused

### Won't Fix (Working as Intended)

8. **Frontend Visualization** (#13) - Implementation exceeds docs, no issue
9. **Substreams** (#14-15) - Low priority, not blocking
10. **Test Configurations** (#17-18) - No actual mismatch

---

## Verification Checklist

Use this checklist before production deployment:

- [ ] Emission multipliers match between README and contract
- [ ] All critical documentation mismatches resolved
- [ ] Directory structure in README matches reality
- [ ] Deployment instructions work and are documented
- [ ] Missing tool references marked as "planned"
- [ ] All fixed mismatches verified with file references
- [ ] Community notified of any economic changes
- [ ] Release notes mention documentation updates

---

## Fixed Mismatches (Historical Record)

These mismatches were identified and fixed during this session:

1. ✅ Missing `release_guests` field - Added to frontend form
2. ✅ Missing `proofs` field - Added source attribution section
3. ✅ `updrespect` signature - README updated to match contract
4. ✅ Docker Compose missing - Created comprehensive docker-compose.yml
5. ✅ Backend README missing - Created comprehensive backend documentation
6. ✅ Tools directory missing - Created stubs with implementation guides
7. ✅ Kubernetes files missing - Created complete k8s/ directory
8. ✅ Frontend visualization incomplete - Added PathTracker and LikeManager

---

## Appendix: File References

Quick reference for verification:

| Mismatch | Documentation | Implementation | Status |
|----------|---------------|----------------|--------|
| #1 Release guests | README.md:286-297 | frontend/index.html:95-107 | ✅ Fixed |
| #2 Emission multipliers | README.md:886-890 | contracts/polaris.music.cpp:1039-1053 | 🔴 Action needed |
| #3 updrespect | README.md:864-867 | contracts/polaris.music.cpp:242-243 | ✅ Fixed |
| #4 Proofs field | README.md:811 | frontend/src/index.js:140-142 | ✅ Fixed |
| #5 Docker Compose | README.md:1019-1028 | docker-compose.yml | ✅ Fixed |
| #6 Config directory | README.md:958 | backend/src/ | 🟡 Update README |
| #7 Tools directory | README.md:919-926 | tools/ | ⏳ Stubs created |
| #8 Deploy script | README.md:1034 | .github/workflows/deploy.yml | 🟡 Update README |
| #9 Performance tests | CLAUDE.md:37 | backend/test/ | 🟡 Create or document |
| #10 Docs files | CLAUDE.md:53-56 | docs/ | 🟡 Create missing |
| #11 K8s files | README.md:977 | k8s/ | ✅ Fixed |
| #12 clear() action | contracts/README.md | polaris.music.cpp:642 | 🟢 Low priority |

---

**Last Updated**: 2026-01-01
**Reviewed By**: AI Code Analysis
**Next Review**: Before mainnet launch
