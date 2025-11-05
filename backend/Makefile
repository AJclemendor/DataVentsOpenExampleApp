PY?=python
VENV?=.venv
PIP=$(VENV)/bin/pip

.PHONY: venv install install-wheel run

venv:
	$(PY) -m venv $(VENV)
	$(VENV)/bin/python -m ensurepip --upgrade
	$(PIP) install --upgrade pip setuptools wheel

install: venv
	$(PIP) install -r requirements.txt

# Install a prebuilt SDK wheel (optional)
# Usage: make install-wheel WHEEL=/path/to/datavents-*.whl
install-wheel: venv
	@test -n "$(WHEEL)" || (echo "Set WHEEL=/path/to/datavents-*.whl" && false)
	$(PIP) install "$(WHEEL)"

run:
	$(VENV)/bin/python main.py
