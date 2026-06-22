# pi-dcp-stable

Dynamic Context Pruning(DCP)을 pi-coding-agent에서 사용할 수 있도록 옮긴 로컬 확장 패키지입니다.

이 패키지는 OpenCode용 원본 DCP인 [`Opencode-DCP/opencode-dynamic-context-pruning`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)의 동작을 참고해, LLM을 통해 pi 확장 API에 맞게 포팅한 버전입니다.

원본의 핵심 기능인 오래되거나 닫힌 대화 구간 압축, 중복/오류 tool output 정리, `/dcp` 명령 흐름을 pi 환경에 맞게 적용했습니다. 여기에 pi 세션에서 압축된 context를 필요할 때 다시 찾아볼 수 있도록 다음 보조 tool을 추가했습니다.

- `dcp_expand_block`: 압축된 DCP block의 원문 일부를 query 기준으로 조회
- `dcp_search_compressed_raw`: 압축된 block들 안의 raw history를 검색

이 lookup tool들은 압축 요약을 대체하는 용도가 아니라, 요약만으로 부족할 때 특정 세부 정보를 다시 확인하기 위한 보조 기능입니다.

## Install

```bash
pi install ./pi-dcp-stable
```

패키지를 수정한 뒤에는 pi를 재시작하거나 `/reload`를 실행하세요.

## Commands

주요 명령은 `/dcp`입니다.

```text
/dcp context
/dcp stats
/dcp manual [on|off]
/dcp compress [focus]
/dcp decompress [N]
/dcp recompress [N]
/dcp sweep [N]
```

`/dcp-stable`은 호환용 alias로 유지됩니다.

## Config

전역 설정 파일:

```text
~/.config/pi/dcp-stable.jsonc
```

프로젝트별 override:

```text
.pi/dcp-stable.jsonc
```

## Notes

- 원본 OpenCode DCP의 개념과 UX를 최대한 유지하되, pi 세션/도구 구조에 맞춰 동작하도록 조정했습니다.
- final answer 직전 불필요한 압축이 답변을 방해하지 않도록 pi용 guardrail을 포함합니다.
- 이 저장소는 현재 pi용 포팅/운영 편의를 위한 패키지이며, upstream 원본은 위 OpenCode DCP 저장소를 참고하세요.
