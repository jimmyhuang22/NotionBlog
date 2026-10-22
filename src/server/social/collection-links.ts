export function checkedCollectionUrl(kind:"season"|"multi-part",accountId:string,collectionId:string,url:string) {
  if(!/^[1-9][0-9]{0,19}$/.test(accountId))return false;
  if(kind==="season")return /^[1-9][0-9]{0,19}$/.test(collectionId) && url===`https://space.bilibili.com/${accountId}/lists/${collectionId}?type=season`;
  return /^BV[0-9A-Za-z]{10}$/.test(collectionId) && url===`https://www.bilibili.com/video/${collectionId}/`;
}
