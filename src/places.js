// places.js — 카카오맵 JS SDK로 지역별 실시간 맛집·관광지 검색
// REST API가 아니라 JS SDK(kakao.maps.services.Places)를 쓰는 이유:
// dapi.kakao.com REST 엔드포인트는 브라우저에서 직접 fetch하면 CORS로 막히고,
// 서버 없는 이 사이트에서는 SDK 방식만 프록시 없이 동작한다.

let readyPromise = null

function ensureKakaoReady() {
  if (readyPromise) return readyPromise
  readyPromise = new Promise((resolve, reject) => {
    if (!window.kakao?.maps?.load) { reject(new Error('kakao maps sdk not loaded')); return }
    window.kakao.maps.load(resolve)
  })
  return readyPromise
}

function searchPlaces(query) {
  return ensureKakaoReady()
    .then(() => new Promise((resolve) => {
      const places = new window.kakao.maps.services.Places()
      places.keywordSearch(query, (data, status) => {
        if (status === window.kakao.maps.services.Status.OK) {
          resolve(data.slice(0, 3).map(d => ({ name: d.place_name, category: (d.category_name || '').split(' > ').pop() })))
        } else {
          resolve([])
        }
      })
    }))
    .catch(() => [])
}

// zone: geo.js의 buildArena가 만든 결과 지역 객체 (name, parent?)
export function fetchTravelInfo(zone) {
  const place = zone.parent ? `${zone.parent} ${zone.name}` : zone.name
  return Promise.all([
    searchPlaces(`${place} 맛집`),
    searchPlaces(`${place} 가볼만한 곳`),
  ]).then(([food, spots]) => ({ food, spots }))
}
