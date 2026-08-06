import domain.order


class Customer:
    def __init__(self, ident):
        self.ident = ident

    @classmethod
    def load(cls, store, ident):
        return cls(ident)

    def orders(self, store):
        return [o for o in store if isinstance(o, domain.order.Order)]
