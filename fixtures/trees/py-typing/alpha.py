from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from beta import Beta


class Alpha:
    def partner(self) -> Beta:
        raise NotImplementedError
