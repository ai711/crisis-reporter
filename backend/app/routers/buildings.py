from fastapi import APIRouter, Query
import httpx

router = APIRouter(prefix="/api", tags=["buildings"])

_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def _overpass_to_geojson(elements: list) -> dict:
    nodes: dict[int, list[float]] = {}
    for el in elements:
        if el.get("type") == "node":
            nodes[el["id"]] = [el["lon"], el["lat"]]

    features = []
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        if not tags.get("building"):
            continue
        ring = [nodes[nid] for nid in el.get("nodes", []) if nid in nodes]
        if len(ring) < 3:
            continue
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        features.append({
            "type": "Feature",
            "properties": {
                "osm_id": el["id"],
                "name": tags.get("name", ""),
                "building": tags.get("building", "yes"),
            },
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })

    return {"type": "FeatureCollection", "features": features}


@router.get("/buildings")
async def get_buildings(
    south: float = Query(...),
    west: float = Query(...),
    north: float = Query(...),
    east: float = Query(...),
):
    """Proxy Overpass API building footprint queries for mobile clients.

    Mobile's Android fetch polyfill sends malformed Content-Type headers on
    POST requests, triggering HTTP 406 from Overpass. Server-side fetch avoids
    this entirely. Returns a GeoJSON FeatureCollection of building polygons.
    """
    query = (
        f"[out:json][timeout:25]"
        f"[bbox:{south:.6f},{west:.6f},{north:.6f},{east:.6f}];"
        f'(way["building"];relation["building"]["type"="multipolygon"];);'
        f"out body;>;out skel qt;"
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        for endpoint in _OVERPASS_ENDPOINTS:
            try:
                resp = await client.get(endpoint, params={"data": query})
                if resp.status_code != 200:
                    continue
                elements = resp.json().get("elements", [])
                if not elements:
                    continue
                return _overpass_to_geojson(elements)
            except Exception:
                continue

    return {"type": "FeatureCollection", "features": []}
