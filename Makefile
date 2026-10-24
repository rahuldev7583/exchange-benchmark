.PHONY: setup layer1 layer1-smoke layer1-full layer1-rust layer1-ts report update-engines

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
