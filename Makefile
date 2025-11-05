.PHONY: dev
dev:
	cd backend && make run

.PHONY: test
test:
	cd backend && pytest -q -s -vv || true
