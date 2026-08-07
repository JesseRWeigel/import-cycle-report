from billing.rates import TABLE


def tax_for(net, currency):
    return net * TABLE.get(currency, 0.0)
