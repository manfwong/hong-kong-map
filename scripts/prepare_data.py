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
# One OpenStreetMap route relation per track alignment. The longest joined
# piece is the passenger line; short leftovers are depot sidings.
ROUTE_RELATIONS = [
    ("TWL", 269669),
    ("TKL", 269672),
    ("TKL", 9736610),
    ("KTL", 272125),
    ("EAL", 4248590),
    ("EAL", 4248589),
    ("EAL", 6587848),
    ("ISL", 4432665),
    ("DRL", 4709540),
    ("AEL", 5317238),
    ("TCL", 5317704),
    ("TML", 6102298),
    ("SIL", 6827212),
]

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


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111_320 * math.cos(lat), (a[1] - b[1]) * 111_320)


def chain_ways(members: list[dict], snap_m: float = 80) -> list[list[tuple[float, float]]]:
    ways: list[list[tuple[float, float]]] = []
    for member in members:
        if member.get("type") != "way" or not member.get("geometry"):
            continue
        points = [(point["lon"], point["lat"]) for point in member["geometry"]]
        if len(points) >= 2:
            ways.append(points)
    unused = set(range(len(ways)))
    lines: list[list[tuple[float, float]]] = []

    def walk(index: int, reverse: bool) -> list[tuple[float, float]]:
        points = list(reversed(ways[index])) if reverse else ways[index][:]
        unused.remove(index)
        while True:
            end = points[-1]
            best: tuple[float, int, int] | None = None
            for other in list(unused):
                for end_index, candidate in ((0, ways[other][0]), (1, ways[other][-1])):
                    gap = metres(end, candidate)
                    if gap <= snap_m and (best is None or gap < best[0]):
                        best = (gap, other, end_index)
            if best is None:
                return points
            _, other, end_index = best
            nxt = ways[other][:] if end_index == 0 else list(reversed(ways[other]))
            points.extend(nxt[1:])
            unused.remove(other)

    def neighbor_count(index: int, end: int) -> int:
        endpoint = ways[index][0] if end == 0 else ways[index][-1]
        count = 0
        for other, way in enumerate(ways):
            if other == index:
                continue
            if metres(endpoint, way[0]) <= snap_m or metres(endpoint, way[-1]) <= snap_m:
                count += 1
        return count

    starts = sorted(
        (neighbor_count(index, end), index, end == 1) for index in range(len(ways)) for end in (0, 1)
    )
    for _, index, reverse in starts:
        if index in unused:
            lines.append(walk(index, reverse))
    while unused:
        lines.append(walk(min(unused), False))
    return lines


def route_features() -> list[dict]:
    ids = ",".join(str(relation_id) for _, relation_id in ROUTE_RELATIONS)
    elements = overpass(f"[out:json][timeout:180];relation(id:{ids});out geom;")
    by_id = {element["id"]: element for element in elements}
    features = []
    for code, relation_id in ROUTE_RELATIONS:
        element = by_id.get(relation_id)
        if element is None:
            raise SystemExit(f"missing OpenStreetMap route {code} {relation_id}")
        pieces = chain_ways(element.get("members") or [])
        if not pieces:
            raise SystemExit(f"empty OpenStreetMap route {code}")
        longest = max(pieces, key=lambda piece: sum(metres(a, b) for a, b in zip(piece, piece[1:])))
        coordinates = []
        for lng, lat in longest:
            point = [round(lng, 6), round(lat, 6)]
            if not coordinates or point != coordinates[-1]:
                coordinates.append(point)
        line = LINE_BY_CODE[code]
        features.append(
            {
                "type": "Feature",
                "properties": {"code": code, "name": line["name"], "color": line["color"]},
                "geometry": {"type": "LineString", "coordinates": coordinates},
            }
        )
        print(code, relation_id, "curve points", len(coordinates))
    return features


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
                        "terminus": is_terminus(code, line_code),
                    }
                    for line_code in line_codes
                ],
            }
        )

    features = route_features()

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
