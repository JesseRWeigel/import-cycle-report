from tools.formatter import fmt


def main(rows):
    return fmt(rows)


if __name__ == "__main__":
    # This import runs only when this file is the program, so it cannot close an import cycle.
    from tools.report import build

    print(main(build()))
