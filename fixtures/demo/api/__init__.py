"""Public surface of the API layer."""

from api.errors import ApiError
from api.routes import router

VERSION = "1.4.0"

__all__ = ["ApiError", "router", "VERSION"]
