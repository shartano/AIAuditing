"""
Pytest configuration for the recon_pipeline test suite.

modal_worker.py imports several packages (modal, fastapi, pydantic) that are
only available inside a Modal container at runtime. This conftest stubs them
into sys.modules before any test file imports from modal_worker, so the module
can be imported in a plain Python environment without those packages installed.

Install test dependencies:
    pip install pytest
"""

import sys
from unittest.mock import MagicMock


def _stub_module(name: str) -> MagicMock:
    mock = MagicMock()
    sys.modules[name] = mock
    return mock


# modal -----------------------------------------------------------------------
# modal.App, modal.Image, modal.Secret, modal.asgi_app, etc. are all used at
# module level in modal_worker.py (decorators + app definition). They must be
# present before the module is imported.
modal_mock = _stub_module("modal")
modal_mock.App.return_value = MagicMock()
modal_mock.Image.debian_slim.return_value = MagicMock(
    apt_install=lambda *a, **kw: MagicMock(
        pip_install=lambda *a, **kw: MagicMock(
            add_local_file=lambda *a, **kw: MagicMock()
        )
    )
)
modal_mock.Secret.from_name.return_value = MagicMock()

# fastapi ---------------------------------------------------------------------
# FastAPI() and HTTPException are used at module level.
fastapi_mock = _stub_module("fastapi")


class _FakeHTTPException(Exception):
    def __init__(self, status_code: int, detail: str = ""):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


fastapi_mock.FastAPI.return_value = MagicMock()
fastapi_mock.HTTPException = _FakeHTTPException

# pydantic --------------------------------------------------------------------
# BaseModel is used as a base class; Field is used as a default-value factory.
pydantic_mock = _stub_module("pydantic")


class _FakeBaseModel:
    """Minimal stand-in for pydantic.BaseModel."""
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


pydantic_mock.BaseModel = _FakeBaseModel
pydantic_mock.Field = lambda default=None, **kw: default