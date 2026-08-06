import domain.customer


class Order:
    def __init__(self, customer_id, total):
        self.customer_id = customer_id
        self.total = total

    def customer(self, store):
        return domain.customer.Customer.load(store, self.customer_id)
