type Environment=Record<string,string|undefined>;
export function platformProduction(env:Environment):boolean;
export function preservePlatformMetadata(source:Environment,target:Environment):void;
