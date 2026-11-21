"""Download official MTR and traffic-camera open data and build map files.

Station coordinates are not in the MTR station list. They are matched from
OpenStreetMap by the official three-letter station code, then saved locally.
"""

from __future__ import annotations

import csv
import io
import json
import math
import ssl
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data"

STATION_CSV = "https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv"
CAMERA_CSV = "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_Tc.csv"
OVERPASS = "https://overpass-api.de/api/interpreter"

LINES = [
    {"code": "AEL", "name": "機場快綫", "color": "#1C7670"},
    {"code": "TCL", "name": "東涌綫", "color": "#F7943E"},
    {"code": "TML", "name": "屯馬綫", "color": "#923011"},
    {"code": "TKL", "name": "將軍澳綫", "color": "#6B208B"},
    {"code": "EAL", "name": "東鐵綫", "color": "#5EB6E4"},
    {"code": "SIL", "name": "南港島綫", "color": "#BAC429"},
    {"code": "TWL", "name": "荃灣綫", "color": "#E2231A"},
    {"code": "ISL", "name": "港島綫", "color": "#007DC5"},
    {"code": "KTL", "name": "觀塘綫", "color": "#1A9431"},
    {"code": "DRL", "name": "迪士尼綫", "color": "#F550A6"},
]
LINE_BY_CODE = {line["code"]: line for line in LINES}

CONTEXT = ssl.create_default_context()


def fetch(url: str, data: bytes | None = None, timeout: int = 90) -> bytes:
    request = urllib.request.Request(
        url,
        data=data,
        headers={"User-Agent": "hk-smart-city-map/0.1 (classroom project; data preparation)"},
    )
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=CONTEXT) as response:
                return response.read()
        except Exception as error:  # noqa: BLE001 - retry transient network errors
            last_error = error
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def overpass(query: str) -> list[dict]:
    payload = urllib.parse.urlencode({"data": query}).encode()
    body = fetch(OVERPASS, data=payload, timeout=120)
    return json.loads(body)["elements"]


def load_stations() -> list[dict]:
    text = fetch(STATION_CSV).decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


def element_point(element: dict) -> tuple[float, float] | None:
    lat = element.get("lat") or (element.get("center") or {}).get("lat")
    lon = element.get("lon") or (element.get("center") or {}).get("lon")
    if lat is None or lon is None:
        return None
    return float(lon), float(lat)


def element_rank(element: dict) -> tuple[int, int, int]:
    tags = element.get("tags") or {}
    railway = tags.get("railway")
    kind = element.get("type")
    railway_score = 2 if railway == "station" else 1 if railway == "stop" else 0
    kind_score = 2 if kind == "way" else 1 if kind == "relation" else 0
    network = tags.get("network") or ""
    network_score = 1 if "MTR" in network or "港鐵" in network else 0
    return railway_score, kind_score, network_score


def choose_coordinates(elements: list[dict]) -> dict[str, tuple[float, float]]:
    best: dict[str, tuple[tuple[int, int, int], tuple[float, float]]] = {}
    for element in elements:
        tags = element.get("tags") or {}
        code = (tags.get("ref") or "").strip()
        point = element_point(element)
        if len(code) != 3 or not code.isalpha() or point is None:
            continue
        rank = element_rank(element)
        current = best.get(code)
        if current is None or rank > current[0]:
            best[code] = (rank, point)
    return {code: point for code, (_, point) in best.items()}


def in_hong_kong(lng: float, lat: float) -> bool:
    return 22.15 <= lat <= 22.58 and 113.75 <= lng <= 114.50


def main() -> None:
    rows = [row for row in load_stations() if (row.get("Station Code") or "").strip()]
    by_code: dict[str, dict] = {}
    membership: dict[str, set[str]] = defaultdict(set)
    variants: dict[str, list[list[str]]] = defaultdict(list)

    for line in LINES:
        directions = sorted({row["Direction"] for row in rows if row["Line Code"] == line["code"]})
        for direction in directions:
            ordered = sorted(
                (row for row in rows if row["Line Code"] == line["code"] and row["Direction"] == direction),
                key=lambda row: float(row["Sequence"]),
            )
            variants[line["code"]].append([row["Station Code"] for row in ordered])

    for row in rows:
        code = row["Station Code"].strip()
        membership[code].add(row["Line Code"])
        by_code.setdefault(
            code,
            {
                "code": code,
                "name": row["Chinese Name"].strip(),
                "nameEn": row["English Name"].strip(),
            },
        )

    print("official stations", len(by_code))
    elements = overpass(
        """
        [out:json][timeout:90];
        (
          nwr["railway"="station"](22.13,113.75,22.58,114.52);
          node["railway"="stop"]["ref"~"^[A-Z]{3}$"](22.13,113.75,22.58,114.52);
        );
        out center tags;
        """
    )
    coordinates = choose_coordinates(elements)
    missing = [code for code in by_code if code not in coordinates]
    missing.append("RAC")
    print("matched", len(coordinates), "lookup", ",".join(sorted(set(missing))))
    if missing:
        pattern = "|".join(sorted(set(missing)))
        extra = overpass(
            f"""
            [out:json][timeout:60];
            nwr["ref"~"^({pattern})$"](22.13,113.75,22.58,114.52);
            out center tags;
            """
        )
        for code, point in choose_coordinates(extra).items():
            coordinates.setdefault(code, point)

    unresolved = [code for code in list(by_code) + ["RAC"] if code not in coordinates or not in_hong_kong(*coordinates.get(code, (0, 0)))]
    if unresolved:
        raise SystemExit(f"missing coordinates: {unresolved}")

    by_code["RAC"] = {"code": "RAC", "name": "馬場", "nameEn": "Racecourse"}
    membership["RAC"].add("EAL")

    def is_terminus(code: str, line_code: str) -> bool:
        relevant = [variant for variant in variants[line_code] if code in variant]
        if not relevant:
            return False
        return all(variant[0] == code or variant[-1] == code for variant in relevant)

    stations = []
    for code, station in sorted(by_code.items(), key=lambda item: item[1]["name"]):
        lng, lat = coordinates[code]
        line_codes = [line["code"] for line in LINES if line["code"] in membership[code]]
        stations.append(
            {
                **station,
                "lng": round(lng, 6),
                "lat": round(lat, 6),
                "lines": [
                    {
                        "code": line_code,
                        "name": LINE_BY_CODE[line_code]["name"],
                        "color": LINE_BY_CODE[line_code]["color"],
                        "terminus": code == "RAC" or is_terminus(code, line_code),
                    }
                    for line_code in line_codes
                ],
            }
        )

    point = {station["code"]: (station["lng"], station["lat"]) for station in stations}

    def route_codes(line_code: str, direction: str) -> list[str]:
        ordered = sorted(
            (row for row in rows if row["Line Code"] == line_code and row["Direction"] == direction),
            key=lambda row: float(row["Sequence"]),
        )
        return [row["Station Code"] for row in ordered]

    raw_segments: list[tuple[str, list[str]]] = []
    for line in LINES:
        raw_segments.append((line["code"], route_codes(line["code"], "DT")))
        if line["code"] == "EAL":
            raw_segments.append(("EAL", ["SHS", "LMC"]))
            raw_segments.append(("EAL", ["UNI", "RAC", "FOT"]))
        if line["code"] == "TKL":
            raw_segments.append(("TKL", ["TKO", "LHP"]))

    edge_owners: dict[frozenset[str], list[str]] = defaultdict(list)
    for line_code, codes in raw_segments:
        for start, end in zip(codes, codes[1:]):
            edge_owners[frozenset((start, end))].append(line_code)

    def offset_point(lng: float, lat: float, east_m: float, north_m: float) -> list[float]:
        return [
            round(lng + east_m / (111_320 * math.cos(math.radians(lat))), 6),
            round(lat + north_m / 111_320, 6),
        ]

    features = []
    for line_code, codes in raw_segments:
        coords = []
        for index, code in enumerate(codes):
            shifts = []
            neighbours = []
            if index > 0:
                neighbours.append(codes[index - 1])
            if index < len(codes) - 1:
                neighbours.append(codes[index + 1])
            for other in neighbours:
                owners = edge_owners[frozenset((code, other))]
                if len(owners) < 2 or line_code not in owners:
                    continue
                slot = owners.index(line_code)
                shift = (slot - (len(owners) - 1) / 2) * 55
                # Use one direction for the shared edge so both ends offset to the same side.
                first, second = sorted((code, other))
                lng1, lat1 = point[first]
                lng2, lat2 = point[second]
                east = (lng2 - lng1) * 111_320 * math.cos(math.radians(lat1))
                north = (lat2 - lat1) * 111_320
                length = math.hypot(east, north) or 1
                # Perpendicular, east/north in metres.
                shifts.append((-north / length * shift, east / length * shift))
            lng, lat = point[code]
            if shifts:
                east_m = sum(item[0] for item in shifts) / len(shifts)
                north_m = sum(item[1] for item in shifts) / len(shifts)
                coords.append(offset_point(lng, lat, east_m, north_m))
            else:
                coords.append([round(lng, 6), round(lat, 6)])
        line = LINE_BY_CODE[line_code]
        features.append(
            {
                "type": "Feature",
                "properties": {"code": line_code, "name": line["name"], "color": line["color"]},
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )

    network = {
        "lines": LINES,
        "stations": stations,
        "routes": {"type": "FeatureCollection", "features": features},
    }
    cameras = load_cameras()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "network.json").write_text(json.dumps(network, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "cameras.json").write_text(json.dumps(cameras, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("wrote", len(stations), "stations", len(features), "route parts", len(cameras), "cameras")


def load_cameras() -> list[dict]:
    text = fetch(CAMERA_CSV).decode("utf-16")
    rows = list(csv.DictReader(io.StringIO(text), delimiter="\t"))
    cameras = []
    seen: set[str] = set()
    for row in rows:
        values = {name.replace("\ufeff", ""): value for name, value in row.items()}
        key = (values.get("key") or "").strip()
        lat = float(values["latitude"])
        lng = float(values["longitude"])
        url = (values.get("url") or "").strip()
        if not key or key in seen or not in_hong_kong(lng, lat) or not url:
            raise SystemExit(f"bad camera row: {key}")
        seen.add(key)
        # The Transport Department list currently points AID09104 (eastbound)
        # at AID09206.JPG and the reverse. The photos themselves are labelled
        # AID09104 EB and AID09206 WB, so the filename must match the key.
        filename = url.rsplit("/", 1)[-1]
        stem = filename.rsplit(".", 1)[0]
        if stem != key:
            url = f"{url.rsplit('/', 1)[0]}/{key}.JPG"
        cameras.append(
            {
                "key": key,
                "region": values.get("region", "").strip(),
                "district": values.get("district", "").strip(),
                "description": values.get("description", "").strip(),
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "url": url,
            }
        )
    return cameras


if __name__ == "__main__":
    main()
