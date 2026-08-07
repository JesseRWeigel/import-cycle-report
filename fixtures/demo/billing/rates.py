from billing.invoice import DEFAULT_CURRENCY

TABLE = {
    "GBP": 0.20,
    "EUR": 0.21,
    "USD": 0.0,
}

FALLBACK = TABLE[DEFAULT_CURRENCY]
