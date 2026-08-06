from catalog.model import Product


class ProductView:
    def __init__(self, product: Product):
        self.product = product

    def title(self):
        return self.product.sku.upper()
