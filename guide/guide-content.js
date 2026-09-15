'use strict';
// 원장 검수 전 초안. 원장님의 명시적 승인 없이 승인 상태로 변경하지 않습니다.
window.IEUM_GUIDE = Object.freeze({
  version: '0.1',
  reviewStatus: 'draft',
  modules: Object.freeze([
    { id: 'understand', title: '턱관절과 근육의 불편감 이해하기', hint: '오늘 설명한 증상과 관리 방향', selected: true, source: 'NIDCR — Overview, Causes, Diagnosis', text: '턱관절과 씹는 근육의 불편감은 여러 요인과 관련될 수 있습니다. 관리 방법은 진찰 결과와 증상에 따라 달라집니다.' },
    { id: 'food', title: '먹기 편한 음식 선택하기', hint: '통증이 있을 때 식사 부담 줄이기', selected: true, source: 'NIDCR — Nonsurgical Treatments; NHS — Do', text: '씹을 때 통증이 있다면 부드럽고 먹기 편한 음식을 선택해 턱의 부담을 줄여 주세요.' },
    { id: 'rest', title: '평소 이를 꽉 물지 않기', hint: '식사하지 않을 때 턱의 힘 살피기', selected: true, source: 'NHS — Don’t', text: '식사하지 않을 때 위아래 치아가 맞닿아 있는지 살펴보세요. 이를 꽉 물고 있다면 힘을 풀어 치아가 살짝 떨어지도록 해 주세요.' },
    { id: 'habits', title: '반복해서 씹는 습관 줄이기', hint: '껌 씹기·손톱이나 펜 물어뜯기', selected: false, source: 'NIDCR — Self-Management; NHS — Don’t', text: '껌을 오래 씹거나 손톱·펜을 물어뜯는 습관을 줄여 주세요.' },
    { id: 'opening', title: '입을 지나치게 크게 벌리지 않기', hint: '하품할 때 입 벌리는 범위 조절', selected: false, source: 'NHS — Don’t', text: '하품할 때 입을 지나치게 크게 벌리지 않도록 주의해 주세요.' },
    { id: 'relax', title: '긴장을 풀 시간 갖기', hint: '편안하게 쉬는 시간 마련', selected: false, source: 'NIDCR — Self-Management; NHS — Do', text: '편안하게 쉬면서 긴장을 풀 수 있는 시간을 가져보세요.' }
  ].map(Object.freeze))
});
