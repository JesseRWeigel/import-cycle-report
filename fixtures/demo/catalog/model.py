from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from catalog.view import ProductView


class Product:
    def __init__(self, sku):
        self.sku = sku

    def describe(self, view: ProductView) -> str:
        return view.title()
