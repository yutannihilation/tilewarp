# Test fixtures

## EPSG definitions

`epsg-3413.json`, `epsg-6677.json` and `epsg-8857.json` are records of the
[EPSG Geodetic Parameter Dataset](https://epsg.org/), as the PROJJSON that
[epsg.io](https://epsg.io/) serves at `https://epsg.io/{code}.json`. They are
unmodified: on 2026-11-03 they matched epsg.io's answers byte for byte.

The EPSG Dataset is owned by the International Association of Oil & Gas
Producers (IOGP). These three files are not covered by this repository's MIT
license. They are redistributed under the
[EPSG Dataset Terms of Use](https://epsg.org/terms-of-use.html), which apply to
anyone who receives them.

## vector.pmtiles

Synthetic features made for these tests with tippecanoe, covered by the
repository's MIT license.
