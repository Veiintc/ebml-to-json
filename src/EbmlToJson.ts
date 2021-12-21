import { EBMLElementDetail, tools, Decoder, Encoder, MasterElement,Reader } from "ts-ebml";
import { EBML, Segment, SimpleBlock, BlockGroup, Cluster } from "./elements";
import { OutputExcludeKeys, MultipleElements } from "./Const";
import { Buffer } from "ts-ebml/lib/tools";
export { Decoder, Encoder, Reader, tools }
export class EbmlToJson {
    public EBML!: EBML;
    public Segment!: Segment;

    /**
     * EBMLファイルを読み込み、EBML・Segmentプロパティに設定する
     * Load the ebml file and set it to EBML・Segment attribute
     * @param buffer 
     */
    public constructor(buffer: ArrayBuffer) {
        const decoder = new Decoder();
        const elms: EBMLElementDetail[] = decoder.decode(buffer);

        const toJsonRecursive = (elms: EBMLElementDetail[], json: any, i = 0, parentLevel = -1) => {
            for (i; i < elms.length; i++) {
                const elm = elms[i];
                if ((<any>elm).isEnd === true) {
                    // 終了タグが出てきたら子要素読み込み終わり
                    break;
                }
                if (parentLevel >= elm.level) {
                    // 終了タグが出てこずに、同じ以上のレベルのタグが出てきたら子要素読み込み終わり
                    i--;
                    break;
                }

                if (elm.type === "m") {
                    // MasterElementの子を読み込む
                    i = toJsonRecursive(elms, elm, i + 1, elm.level);
                }

                let propertyName: string;
                if (elm.name === "BlockGroup" || elm.name === "SimpleBlock") {
                    // ブロック要素にtrackNumberとtimecode設定
                    const blockElm = <BlockGroup | SimpleBlock>elm;
                    const blockBuf = elm.name === "BlockGroup" ? (<BlockGroup>blockElm).Block.value : (<SimpleBlock>blockElm).value;
                    const blockData = tools.readBlock(blockBuf);
                    blockElm.trackNumber = blockData.trackNumber;
                    blockElm.timecode = blockData.timecode;
                    propertyName = "blocks";
                }
                else {
                    if (elm.type === "m" && elm.name === "Cluster") {
                        const cluster = <Cluster>elm;

                        // 一つ前のClusterの、最後のブロックのblockDurationを設定する
                        if ((json["Cluster"] || []).length > 0) {
                            const prevCluster = <Cluster>json["Cluster"].slice(-1)[0];
                            if ((prevCluster.blocks || []).length > 0) {
                                const processed: { [trackNumber: number]: boolean } = {}
                                Object.assign([], prevCluster.blocks).reverse().forEach(b => {
                                    const tn = b.trackNumber;   // trackNumberごとに処理
                                    if (!processed[tn]) {
                                        b.blockDuration = cluster.Timecode.value - (prevCluster.Timecode.value + b.timecode);
                                        processed[tn] = true;
                                    }
                                });
                            }
                        }

                        // 各ブロックにblockDurationを設定する
                        if ((cluster.blocks || []).length > 0) {
                            const trackNumbers = [...new Set(cluster.blocks.map(b => b.trackNumber))];
                            for (const tn of trackNumbers) {
                                const blocks = cluster.blocks.filter(b => b.trackNumber == tn);
                                for (let i = 1; i < blocks.length; i++) {
                                    const prevBlock = blocks[i - 1];
                                    prevBlock.blockDuration = blocks[i].timecode - prevBlock.timecode;
                                }
                            }
                        }
                    }

                    propertyName = elm.name;
                }

                if (MultipleElements.indexOf(propertyName) >= 0) {
                    if (json[propertyName] == null) {
                        json[propertyName] = [];
                    }
                    json[propertyName].push(elm);
                }
                else {
                    json[propertyName] = elm;
                }
            }

            return i;
        }

        toJsonRecursive(elms, this);
        this.formatFix();
    }
    /**
     * fix duration and ignore error block
     */
    public formatFix(): void {
        const Segment = <any>this.Segment;
        if (Segment.blocks) {
            delete Segment.blocks;
        }
        const startTime = Segment.Cluster[0].Timecode.value;
        if (startTime !== 0) {
            Segment.Cluster.forEach((e: Cluster) => {
                e.Timecode.value = e.Timecode.value - startTime;
            })
            delete Segment.Info[0].Duration;
        }
        if (!Segment.Info[0].Duration) {
            const lastCluster = Segment.Cluster[Segment.Cluster.length - 1];
            const lastBlocks = lastCluster.blocks[lastCluster.blocks.length - 1];
            const duration = lastCluster.Timecode.value + lastBlocks.timecode + 30;
            Segment.Info[0].Duration = {
                EBML_ID: "4489",
                type: "f",
                name: "Duration",
                level: 2,
                data: null,
                schema: {
                    description: "Duration of the segment (based on TimecodeScale).",
                    level: 2,
                    minver: 1,
                    name: "Duration",
                    range: "> 0",
                    type: "f",
                },
                dataEnd: null,
                dataSize: null,
                dataStart: null,
                sizeEnd: null,
                sizeStart: null,
                tagEnd: null,
                tagStart: null,
                value: duration
            };
            Segment.Info[0].Duration = tools.encodeValueToBuffer(<any>Segment.Info[0].Duration);
        }
    }

    /**
     * Json化したEBMLファイルをBlobにして返します。
     * Restore the JSON ebml file to blob.
     * @param codecs 
     */
    public toBlob(codecs: string): Blob {
        const buf = this.toBuffer();
        return new Blob([buf], { type: `video/webm; codecs=${codecs}` });
    }
    /**
     * convert JSON EBML to ArrayBuffer
     * @returns ArrayBuffer
     */
    public toBuffer(): ArrayBuffer {
        const elms = this._jsonToElmArray();
        const encoder = new Encoder();
        return encoder.encode(elms);
    }
    /**
     * clone a new EbmlToJson class
     * @returns EbmlToJson
     */
    public clone(): EbmlToJson {
        const arrayBuffer = this.toBuffer();
        return new EbmlToJson(arrayBuffer);
    }
    /**
     * cut in approximate range
     * @param startTime start time of cut 
     * @param endTime end time of cut 
     * @returns EbmlToJson
     */
    public slice(startTime: number, endTime: number): EbmlToJson {
        const ret = this.clone();
        const duration = ret.Segment.Info[0].Duration!.value;
        if (startTime < 0) {
            startTime = duration + startTime;
        }
        if (endTime < 0) {
            endTime = duration + endTime;
        }
        if (endTime > duration || !endTime) endTime = duration;
        if (startTime > endTime) throw new Error(`Error startTime:${startTime} ,endTime:${endTime}`);
        const clusterStartIndex = ret.Segment.Cluster.findIndex(e => e.Timecode.value >= startTime);
        const clusterEndIndex = ret.Segment.Cluster.findIndex(e => e.Timecode.value >= endTime) ?? ret.Segment.Cluster.length;
        const body = ret.Segment.Cluster.slice(clusterStartIndex, clusterEndIndex);
        if (clusterEndIndex !== ret.Segment.Cluster.length) {
            const endCluster = ret.Segment.Cluster[clusterEndIndex - 1];
            let endDuration = endTime - endCluster.Timecode.value;
            endCluster.blocks = endCluster.blocks.filter(e => {
                if (endDuration < 0) return false;
                endDuration = endDuration - e.blockDuration;
                return true;
            })
            body[body.length - 1] = endCluster;
        }
        if (clusterStartIndex !== 0) {
            const startCluster = ret.Segment.Cluster[clusterStartIndex - 1];
            let startDuration = startTime - startCluster.Timecode.value;
            startCluster.blocks = startCluster.blocks.reverse().filter(e => {
                if (startDuration < 0) return false;
                startDuration = startDuration - e.blockDuration;
                return true;
            }).reverse()
            startCluster.Timecode.value = startTime - startDuration;
            body.unshift(startCluster);
        }
        ret.Segment.Cluster = body;
        delete ret.Segment.Info[0].Duration;
        ret.formatFix();
        return ret
    }
    /**
     * Json化したEBMLファイルを文字列で出力します。
     * Output the JSON ebml file as a string.
     */
    public toString():string {
        return JSON.stringify({ EBML: this.EBML, Segment: this.Segment }, function (k, v) {
            if (OutputExcludeKeys.includes(k)) {
                return;
            }

            if (v.value instanceof Int8Array ||
                v.value instanceof Uint8Array ||
                v.value instanceof Uint8ClampedArray ||
                v.value instanceof Int16Array ||
                v.value instanceof Uint16Array ||
                v.value instanceof Int32Array ||
                v.value instanceof Uint32Array ||
                v.value instanceof Float32Array ||
                v.value instanceof Float64Array ||
                v.value instanceof BigInt64Array ||
                v.value instanceof BigUint64Array ||
                v.value instanceof ArrayBuffer ||
                v.value instanceof Buffer) {
                v = Object.assign({}, v, { value: `${v.value.constructor.name}(${v.value.byteLength})` });
            }

            const includeKeys = Object.keys(v).filter(k => !OutputExcludeKeys.includes(k));
            if (includeKeys.length == 1 && includeKeys[0] == "value") {
                return v.value;
            }
            else {
                return v
            }
        }, "    ");
    }

    private _jsonToElmArray() {
        const jsonToElmArrayRecursive = (elm: EBMLElementDetail) => {
            const cElm = Object.assign({}, elm);
            const arr: EBMLElementDetail[] = [<any>cElm];
            for (const k of Object.keys(cElm)) {
                if (OutputExcludeKeys.includes(k)) {
                    continue;
                }

                let e = cElm[k];
                if (e != null && (e.type != null || Array.isArray(e))) {
                    const children = Array.isArray(e) ? e : [e];
                    children.forEach(c => {
                        if (c.type === "b") {
                            if (c.value instanceof Array) {
                                c.value = new Buffer(c.value);
                            }
                        }

                        if (c.name === "BlockGroup" || c.name === "SimpleBlock") {
                            const block = c.name === "BlockGroup" ? c.Block : c;
                            const dataBuffer: Buffer = block.value;
                            let offset: number;
                            for (offset = 1; offset <= 8; offset++) {
                                if (dataBuffer[0] >= Math.pow(2, 8 - offset)) break;
                            }
                            dataBuffer.writeInt16BE(c.timecode, offset);
                            block.value = dataBuffer;
                        }

                        if (c.type !== "i") {
                            c = tools.encodeValueToBuffer(c);
                        }
                        else {
                            let bytes = 1;
                            for (; c.value >= Math.pow(2, 8 * bytes - 1); bytes++) { }
                            if (bytes >= 7) {
                                throw "7bit or more bigger uint not supported.";
                            }
                            const data = new Buffer(bytes);
                            data.writeIntBE(c.value, 0, bytes);

                            c.data = data;
                        }

                        arr.push.apply(arr, c.type === "m" ? jsonToElmArrayRecursive(c) : [c]);
                    });

                    delete cElm[k];
                }
            }

            if (!(<MasterElement>cElm).unknownSize) {
                const eElm = Object.assign({}, cElm);
                arr.push(<any>{ ...eElm, isEnd: true });
            }
            return arr;
        }

        return [...jsonToElmArrayRecursive(this.EBML), ...jsonToElmArrayRecursive(this.Segment)];
    }
}