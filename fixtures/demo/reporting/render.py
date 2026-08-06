HEADER = "Orders report"


def render(rows):
    from reporting.summary import summarize

    return f"{HEADER}\n{summarize(rows)}"
