.PHONY: layer2-smoke layer2-full layer2-report layer2-clean engine-setup-rust engine-setup-ts engine-rust engine-ts setup layer1 layer1-smoke layer1-full layer1-rust layer1-ts report update-engines

setup:
	./scripts/setup.sh

layer1-smoke:
	./scripts/run-layer1.sh smoke

layer1:
	./scripts/run-layer1.sh default

layer1-full:
	./scripts/run-layer1.sh full

layer1-rust:
	./scripts/run-layer1.sh default rust

layer1-ts:
	./scripts/run-layer1.sh default ts

report:
	bun scripts/report.ts results/latest

update-engines:
	git submodule update --remote --merge

# ---- Layer 2 (engine service over Redis) ----
# Engine host: make engine-setup-<rust|ts>, then make engine-<rust|ts> (one at a time)
# Load generator host: make layer2-smoke ENGINE=<rust|ts>, then make layer2-full ENGINE=<rust|ts>
ENGINE ?= rust

engine-setup-rust:
	./scripts/setup-engine.sh rust

engine-setup-ts:
	./scripts/setup-engine.sh ts

engine-rust:
	./scripts/start-engine.sh rust

engine-ts:
	./scripts/start-engine.sh ts

layer2-smoke:
	./scripts/run-layer2.sh $(ENGINE) smoke

layer2-full:
	./scripts/run-layer2.sh $(ENGINE) full

layer2-report:
	bun scripts/report-layer2.ts --latest full

layer2-clean:
	@set -a; [ -f .env ] && . ./.env; set +a; cd layer2-service && bun clean-redis.ts
