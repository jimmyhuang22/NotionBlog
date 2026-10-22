export interface CloudPlan {version:1;paths:string[];destinations:{host:string;port:number}[];maxRequests:number;maxConnections:number;maxReceivedBytes:number}
export function validatePlan(plan: unknown): CloudPlan;
export function unusedLocalPort(): Promise<number>;
export function createCloudSession(plan: CloudPlan,onStop?: (reason:string)=>void): Promise<{
 mapping:{host:string;port:number;localPort:number}[];
 state:{requests:number;connections:number;receivedBytes:number;stopped:boolean;reason:string|null};
 stop(reason:string):void;
 gateway(port:number,nextPort:number):Promise<void>;
}>;
