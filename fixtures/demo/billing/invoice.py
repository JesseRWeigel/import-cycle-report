from billing.tax import tax_for


class Invoice:
    def __init__(self, lines):
        self.lines = lines

    def total(self):
        net = sum(line.amount for line in self.lines)
        return net + tax_for(net, DEFAULT_CURRENCY)


# Somebody put the default down here, under the class that uses it. By the time billing.rates
# reaches back for it, this line has not run yet.
DEFAULT_CURRENCY = "GBP"
