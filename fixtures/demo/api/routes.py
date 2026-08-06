from api import VERSION
from api.errors import ApiError


def router(path):
    if path == "/version":
        return VERSION
    raise ApiError(path)
