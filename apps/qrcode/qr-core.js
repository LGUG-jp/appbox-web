/*
 * Local QR Code core for お役立ちアプリBOX
 *
 * QR Code algorithm source:
 * Copyright (c) 2009 Kazuhiko Arase
 * Licensed under the MIT License.
 *
 * This browser bundle was prepared from the QRCode vendor source included
 * with qrcode-terminal 0.12.0 and adapted for local browser use.
 *
 * Changes in this local edition:
 * - QR versions 1 through 40
 * - Strict automatic capacity selection
 * - UTF-8 encoding with ECI assignment 26
 * - Unicode surrogate-pair handling
 * - ISO-style mask penalty evaluation
 *
 * See THIRD_PARTY_LICENSES.txt for notices.
 */
(function (global) {
  "use strict";

  var modules = {};
  var cache = {};

  function define(name, factory) {
    modules[name] = factory;
  }

  function require(name) {
    if (cache[name]) {
      return cache[name].exports;
    }

    if (!modules[name]) {
      throw new Error(
        "Module not found: " + name
      );
    }

    var module = {
      exports: {}
    };

    cache[name] = module;

    modules[name](
      module,
      module.exports,
      require
    );

    return module.exports;
  }

  define(
    "QRMode",
    function (module) {
      module.exports = {
        MODE_NUMBER: 1 << 0,
        MODE_ALPHA_NUM: 1 << 1,
        MODE_8BIT_BYTE: 1 << 2,
        MODE_KANJI: 1 << 3,
        /* ECI mode indicator is the four-bit value 0111. */
        MODE_ECI: 7
      };
    }
  );

  define(
    "QRErrorCorrectLevel",
    function (module) {
      module.exports = {
        L: 1,
        M: 0,
        Q: 3,
        H: 2
      };
    }
  );

  define(
    "QRMaskPattern",
    function (module) {
      module.exports = {
        PATTERN000: 0,
        PATTERN001: 1,
        PATTERN010: 2,
        PATTERN011: 3,
        PATTERN100: 4,
        PATTERN101: 5,
        PATTERN110: 6,
        PATTERN111: 7
      };
    }
  );

  define(
    "QRMath",
    function (module) {
      var QRMath = {
        glog: function (n) {
          if (n < 1) {
            throw new Error(
              "glog(" + n + ")"
            );
          }

          return QRMath.LOG_TABLE[n];
        },

        gexp: function (n) {
          while (n < 0) {
            n += 255;
          }

          while (n >= 256) {
            n -= 255;
          }

          return QRMath.EXP_TABLE[n];
        },

        EXP_TABLE: new Array(256),
        LOG_TABLE: new Array(256)
      };

      var i;

      for (i = 0; i < 8; i++) {
        QRMath.EXP_TABLE[i] =
          1 << i;
      }

      for (i = 8; i < 256; i++) {
        QRMath.EXP_TABLE[i] =
          QRMath.EXP_TABLE[i - 4] ^
          QRMath.EXP_TABLE[i - 5] ^
          QRMath.EXP_TABLE[i - 6] ^
          QRMath.EXP_TABLE[i - 8];
      }

      for (i = 0; i < 255; i++) {
        QRMath.LOG_TABLE[
          QRMath.EXP_TABLE[i]
        ] = i;
      }

      module.exports = QRMath;
    }
  );

  define(
    "QRPolynomial",
    function (module, exports, require) {
      var QRMath =
        require("QRMath");

      function QRPolynomial(
        num,
        shift
      ) {
        if (!num ||
            num.length === undefined) {
          throw new Error(
            "Invalid polynomial"
          );
        }

        var offset = 0;

        while (
          offset < num.length &&
          num[offset] === 0
        ) {
          offset++;
        }

        this.num = new Array(
          num.length - offset + shift
        );

        for (
          var i = 0;
          i < num.length - offset;
          i++
        ) {
          this.num[i] =
            num[i + offset];
        }
      }

      QRPolynomial.prototype = {
        get: function (index) {
          return this.num[index];
        },

        getLength: function () {
          return this.num.length;
        },

        multiply: function (other) {
          var num = new Array(
            this.getLength() +
            other.getLength() -
            1
          );

          for (
            var x = 0;
            x < num.length;
            x++
          ) {
            num[x] = 0;
          }

          for (
            var i = 0;
            i < this.getLength();
            i++
          ) {
            for (
              var j = 0;
              j < other.getLength();
              j++
            ) {
              num[i + j] ^=
                QRMath.gexp(
                  QRMath.glog(
                    this.get(i)
                  ) +
                  QRMath.glog(
                    other.get(j)
                  )
                );
            }
          }

          return new QRPolynomial(
            num,
            0
          );
        },

        mod: function (other) {
          if (
            this.getLength() -
              other.getLength() <
            0
          ) {
            return this;
          }

          var ratio =
            QRMath.glog(
              this.get(0)
            ) -
            QRMath.glog(
              other.get(0)
            );

          var num = new Array(
            this.getLength()
          );

          for (
            var i = 0;
            i < this.getLength();
            i++
          ) {
            num[i] = this.get(i);
          }

          for (
            var x = 0;
            x < other.getLength();
            x++
          ) {
            num[x] ^=
              QRMath.gexp(
                QRMath.glog(
                  other.get(x)
                ) +
                ratio
              );
          }

          return new QRPolynomial(
            num,
            0
          ).mod(other);
        }
      };

      module.exports =
        QRPolynomial;
    }
  );

  define(
    "QRRSBlock",
    function (module, exports, require) {
      var QRErrorCorrectLevel =
        require(
          "QRErrorCorrectLevel"
        );

      function QRRSBlock(
        totalCount,
        dataCount
      ) {
        this.totalCount =
          totalCount;

        this.dataCount =
          dataCount;
      }

      QRRSBlock.RS_BLOCK_TABLE = [
        [1,26,19],[1,26,16],[1,26,13],[1,26,9],
        [1,44,34],[1,44,28],[1,44,22],[1,44,16],
        [1,70,55],[1,70,44],[2,35,17],[2,35,13],
        [1,100,80],[2,50,32],[2,50,24],[4,25,9],
        [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],
        [2,86,68],[4,43,27],[4,43,19],[4,43,15],
        [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],
        [2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
        [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],
        [2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
        [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],
        [2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
        [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],
        [3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
        [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],
        [5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
        [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],
        [5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
        [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],
        [3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
        [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],
        [2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
        [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],
        [6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
        [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],
        [10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
        [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],
        [3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
        [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],
        [5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
        [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],
        [17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
        [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],
        [13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
        [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],
        [6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
        [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],
        [4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
        [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],
        [19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]
      ];

      QRRSBlock.validateTable =
        function () {
          var table =
            QRRSBlock.RS_BLOCK_TABLE;

          if (
            !Array.isArray(table) ||
            table.length !== 160
          ) {
            throw new Error(
              "Invalid RS block table length: " +
              (
                Array.isArray(table)
                  ? table.length
                  : "not-array"
              )
            );
          }

          for (
            var version = 1;
            version <= 40;
            version++
          ) {
            var expectedTotal = null;

            for (
              var levelIndex = 0;
              levelIndex < 4;
              levelIndex++
            ) {
              var row =
                table[
                  (version - 1) * 4 +
                  levelIndex
                ];

              if (
                !Array.isArray(row) ||
                row.length === 0 ||
                row.length % 3 !== 0
              ) {
                throw new Error(
                  "Invalid RS block row: " +
                  "version=" +
                  version +
                  ", levelIndex=" +
                  levelIndex
                );
              }

              var totalCodewords = 0;

              for (
                var index = 0;
                index < row.length;
                index += 3
              ) {
                var count =
                  row[index];

                var totalCount =
                  row[index + 1];

                var dataCount =
                  row[index + 2];

                if (
                  !Number.isInteger(count) ||
                  !Number.isInteger(totalCount) ||
                  !Number.isInteger(dataCount) ||
                  count < 1 ||
                  totalCount < 1 ||
                  dataCount < 1 ||
                  dataCount >= totalCount
                ) {
                  throw new Error(
                    "Invalid RS block value: " +
                    "version=" +
                    version +
                    ", levelIndex=" +
                    levelIndex +
                    ", group=" +
                    index / 3
                  );
                }

                totalCodewords +=
                  count * totalCount;
              }

              /*
              * 同一バージョンでは、誤り訂正レベルが
              * 異なっても総コード語数は等しい。
              */
              if (expectedTotal === null) {
                expectedTotal =
                  totalCodewords;
              } else if (
                totalCodewords !==
                expectedTotal
              ) {
                throw new Error(
                  "RS block total mismatch: " +
                  "version=" +
                  version +
                  ", expected=" +
                  expectedTotal +
                  ", actual=" +
                  totalCodewords
                );
              }
            }
          }

          return true;
        };

      QRRSBlock.validateTable();

      QRRSBlock.getRSBlocks =
        function (
          typeNumber,
          errorCorrectLevel
        ) {
          var rsBlock =
            QRRSBlock.getRsBlockTable(
              typeNumber,
              errorCorrectLevel
            );

          if (!rsBlock) {
            throw new Error(
              "bad rs block @ typeNumber:" +
              typeNumber +
              "/errorCorrectLevel:" +
              errorCorrectLevel
            );
          }

          var length =
            rsBlock.length / 3;

          var list = [];

          for (
            var i = 0;
            i < length;
            i++
          ) {
            var count =
              rsBlock[i * 3];

            var totalCount =
              rsBlock[i * 3 + 1];

            var dataCount =
              rsBlock[i * 3 + 2];

            for (
              var j = 0;
              j < count;
              j++
            ) {
              list.push(
                new QRRSBlock(
                  totalCount,
                  dataCount
                )
              );
            }
          }

          return list;
        };

      QRRSBlock.getRsBlockTable =
        function (
          typeNumber,
          errorCorrectLevel
        ) {
          var index =
            (typeNumber - 1) * 4;

          switch (
            errorCorrectLevel
          ) {
            case QRErrorCorrectLevel.L:
              return QRRSBlock
                .RS_BLOCK_TABLE[
                  index
                ];

            case QRErrorCorrectLevel.M:
              return QRRSBlock
                .RS_BLOCK_TABLE[
                  index + 1
                ];

            case QRErrorCorrectLevel.Q:
              return QRRSBlock
                .RS_BLOCK_TABLE[
                  index + 2
                ];

            case QRErrorCorrectLevel.H:
              return QRRSBlock
                .RS_BLOCK_TABLE[
                  index + 3
                ];

            default:
              return undefined;
          }
        };

      module.exports =
        QRRSBlock;
    }
  );

  define(
    "QRBitBuffer",
    function (module) {
      function QRBitBuffer() {
        this.buffer = [];
        this.length = 0;
      }

      QRBitBuffer.prototype = {
        get: function (index) {
          var bufIndex =
            Math.floor(index / 8);

          return (
            (
              this.buffer[
                bufIndex
              ] >>>
              (7 - index % 8)
            ) &
            1
          ) === 1;
        },

        put: function (
          num,
          length
        ) {
          for (
            var i = 0;
            i < length;
            i++
          ) {
            this.putBit(
              (
                num >>>
                (length - i - 1)
              ) &
              1
            );
          }
        },

        getLengthInBits:
          function () {
            return this.length;
          },

        putBit: function (bit) {
          var bufIndex =
            Math.floor(
              this.length / 8
            );

          if (
            this.buffer.length <=
            bufIndex
          ) {
            this.buffer.push(0);
          }

          if (bit) {
            this.buffer[bufIndex] |=
              0x80 >>>
              (this.length % 8);
          }

          this.length++;
        }
      };

      module.exports =
        QRBitBuffer;
    }
  );

  define(
    "QR8bitByte",
    function (module, exports, require) {
      var QRMode =
        require("QRMode");

      function toUtf8Bytes(data) {
        var bytes = [];

        for (
          var i = 0;
          i < data.length;
          i++
        ) {
          var code =
            data.charCodeAt(i);

          if (
            code >= 0xD800 &&
            code <= 0xDBFF
          ) {
            if (
              i + 1 <
              data.length
            ) {
              var next =
                data.charCodeAt(
                  i + 1
                );

              if (
                next >= 0xDC00 &&
                next <= 0xDFFF
              ) {
                var cp =
                  0x10000 +
                  (
                    (code - 0xD800) <<
                    10
                  ) +
                  (next - 0xDC00);

                bytes.push(
                  0xF0 |
                    (
                      cp >> 18
                    ),
                  0x80 |
                    (
                      (cp >> 12) &
                      0x3F
                    ),
                  0x80 |
                    (
                      (cp >> 6) &
                      0x3F
                    ),
                  0x80 |
                    (
                      cp & 0x3F
                    )
                );

                i++;
                continue;
              }
            }

            code = 0xFFFD;
          } else if (
            code >= 0xDC00 &&
            code <= 0xDFFF
          ) {
            code = 0xFFFD;
          }

          if (code < 0x80) {
            bytes.push(code);
          } else if (
            code < 0x800
          ) {
            bytes.push(
              0xC0 |
                (code >> 6),
              0x80 |
                (code & 0x3F)
            );
          } else {
            bytes.push(
              0xE0 |
                (code >> 12),
              0x80 |
                (
                  (code >> 6) &
                  0x3F
                ),
              0x80 |
                (code & 0x3F)
            );
          }
        }

        return bytes;
      }

      function QR8bitByte(data) {
        this.mode =
          QRMode.MODE_8BIT_BYTE;

        this.data =
          String(data);

        this.parsedData =
          toUtf8Bytes(this.data);
      }

      QR8bitByte.prototype = {
        getLength: function () {
          return this
            .parsedData.length;
        },

        write: function (buffer) {
          for (
            var i = 0;
            i <
            this.parsedData.length;
            i++
          ) {
            buffer.put(
              this.parsedData[i],
              8
            );
          }
        }
      };

      QR8bitByte.toUtf8Bytes =
        toUtf8Bytes;

      QR8bitByte.isAscii =
        function (value) {
          var text = String(value);

          for (
            var i = 0;
            i < text.length;
            i++
          ) {
            if (
              text.charCodeAt(i) >
              0x7F
            ) {
              return false;
            }
          }

          return true;
        };

      module.exports =
        QR8bitByte;
    }
  );

  define(
    "QRECI",
    function (module, exports, require) {
      var QRMode =
        require("QRMode");

      function QRECI(
        assignmentNumber
      ) {
        this.mode =
          QRMode.MODE_ECI;

        this.assignmentNumber =
          assignmentNumber;
      }

      QRECI.prototype = {
        write: function (buffer) {
          var value =
            this.assignmentNumber;

          if (value < 0) {
            throw new Error(
              "Invalid ECI assignment"
            );
          }

          if (value < 128) {
            buffer.put(
              value,
              8
            );
          } else if (
            value < 16384
          ) {
            buffer.put(
              0x8000 | value,
              16
            );
          } else if (
            value < 1000000
          ) {
            buffer.put(
              0xC00000 | value,
              24
            );
          } else {
            throw new Error(
              "Invalid ECI assignment"
            );
          }
        }
      };

      module.exports = QRECI;
    }
  );

  define(
    "QRUtil",
    function (module, exports, require) {
      var QRMode =
        require("QRMode");

      var QRPolynomial =
        require("QRPolynomial");

      var QRMath =
        require("QRMath");

      var QRMaskPattern =
        require("QRMaskPattern");

      var QRUtil = {
        PATTERN_POSITION_TABLE: [
          [],
          [6,18],
          [6,22],
          [6,26],
          [6,30],
          [6,34],
          [6,22,38],
          [6,24,42],
          [6,26,46],
          [6,28,50],
          [6,30,54],
          [6,32,58],
          [6,34,62],
          [6,26,46,66],
          [6,26,48,70],
          [6,26,50,74],
          [6,30,54,78],
          [6,30,56,82],
          [6,30,58,86],
          [6,34,62,90],
          [6,28,50,72,94],
          [6,26,50,74,98],
          [6,30,54,78,102],
          [6,28,54,80,106],
          [6,32,58,84,110],
          [6,30,58,86,114],
          [6,34,62,90,118],
          [6,26,50,74,98,122],
          [6,30,54,78,102,126],
          [6,26,52,78,104,130],
          [6,30,56,82,108,134],
          [6,34,60,86,112,138],
          [6,30,58,86,114,142],
          [6,34,62,90,118,146],
          [6,30,54,78,102,126,150],
          [6,24,50,76,102,128,154],
          [6,28,54,80,106,132,158],
          [6,32,58,84,110,136,162],
          [6,26,54,82,110,138,166],
          [6,30,58,86,114,142,170]
        ],

        G15:
          (1 << 10) |
          (1 << 8) |
          (1 << 5) |
          (1 << 4) |
          (1 << 2) |
          (1 << 1) |
          1,

        G18:
          (1 << 12) |
          (1 << 11) |
          (1 << 10) |
          (1 << 9) |
          (1 << 8) |
          (1 << 5) |
          (1 << 2) |
          1,

        G15_MASK:
          (1 << 14) |
          (1 << 12) |
          (1 << 10) |
          (1 << 4) |
          (1 << 1),

        getBCHTypeInfo:
          function (data) {
            var d = data << 10;

            while (
              QRUtil.getBCHDigit(d) -
                QRUtil.getBCHDigit(
                  QRUtil.G15
                ) >=
              0
            ) {
              d ^=
                QRUtil.G15 <<
                (
                  QRUtil.getBCHDigit(
                    d
                  ) -
                  QRUtil.getBCHDigit(
                    QRUtil.G15
                  )
                );
            }

            return (
              (
                data << 10
              ) |
              d
            ) ^
            QRUtil.G15_MASK;
          },

        getBCHTypeNumber:
          function (data) {
            var d = data << 12;

            while (
              QRUtil.getBCHDigit(d) -
                QRUtil.getBCHDigit(
                  QRUtil.G18
                ) >=
              0
            ) {
              d ^=
                QRUtil.G18 <<
                (
                  QRUtil.getBCHDigit(
                    d
                  ) -
                  QRUtil.getBCHDigit(
                    QRUtil.G18
                  )
                );
            }

            return (
              data << 12
            ) | d;
          },

        getBCHDigit:
          function (data) {
            var digit = 0;

            while (data !== 0) {
              digit++;
              data >>>= 1;
            }

            return digit;
          },

        getPatternPosition:
          function (typeNumber) {
            return QRUtil
              .PATTERN_POSITION_TABLE[
                typeNumber - 1
              ];
          },

        getMask:
          function (
            maskPattern,
            i,
            j
          ) {
            switch (maskPattern) {
              case QRMaskPattern
                .PATTERN000:
                return (
                  (i + j) % 2 === 0
                );

              case QRMaskPattern
                .PATTERN001:
                return (
                  i % 2 === 0
                );

              case QRMaskPattern
                .PATTERN010:
                return (
                  j % 3 === 0
                );

              case QRMaskPattern
                .PATTERN011:
                return (
                  (i + j) % 3 === 0
                );

              case QRMaskPattern
                .PATTERN100:
                return (
                  (
                    Math.floor(i / 2) +
                    Math.floor(j / 3)
                  ) %
                    2 ===
                  0
                );

              case QRMaskPattern
                .PATTERN101:
                return (
                  (i * j) % 2 +
                    (i * j) % 3 ===
                  0
                );

              case QRMaskPattern
                .PATTERN110:
                return (
                  (
                    (i * j) % 2 +
                    (i * j) % 3
                  ) %
                    2 ===
                  0
                );

              case QRMaskPattern
                .PATTERN111:
                return (
                  (
                    (i * j) % 3 +
                    (i + j) % 2
                  ) %
                    2 ===
                  0
                );

              default:
                throw new Error(
                  "bad maskPattern:" +
                  maskPattern
                );
            }
          },

        getErrorCorrectPolynomial:
          function (
            errorCorrectLength
          ) {
            var polynomial =
              new QRPolynomial(
                [1],
                0
              );

            for (
              var i = 0;
              i <
              errorCorrectLength;
              i++
            ) {
              polynomial =
                polynomial.multiply(
                  new QRPolynomial(
                    [
                      1,
                      QRMath.gexp(i)
                    ],
                    0
                  )
                );
            }

            return polynomial;
          },

        getLengthInBits:
          function (
            mode,
            type
          ) {
            if (
              type >= 1 &&
              type < 10
            ) {
              switch (mode) {
                case QRMode
                  .MODE_NUMBER:
                  return 10;

                case QRMode
                  .MODE_ALPHA_NUM:
                  return 9;

                case QRMode
                  .MODE_8BIT_BYTE:
                  return 8;

                case QRMode
                  .MODE_KANJI:
                  return 8;

                default:
                  throw new Error(
                    "mode:" + mode
                  );
              }
            }

            if (type < 27) {
              switch (mode) {
                case QRMode
                  .MODE_NUMBER:
                  return 12;

                case QRMode
                  .MODE_ALPHA_NUM:
                  return 11;

                case QRMode
                  .MODE_8BIT_BYTE:
                  return 16;

                case QRMode
                  .MODE_KANJI:
                  return 10;

                default:
                  throw new Error(
                    "mode:" + mode
                  );
              }
            }

            if (type < 41) {
              switch (mode) {
                case QRMode
                  .MODE_NUMBER:
                  return 14;

                case QRMode
                  .MODE_ALPHA_NUM:
                  return 13;

                case QRMode
                  .MODE_8BIT_BYTE:
                  return 16;

                case QRMode
                  .MODE_KANJI:
                  return 12;

                default:
                  throw new Error(
                    "mode:" + mode
                  );
              }
            }

            throw new Error(
              "type:" + type
            );
          },

        getLostPoint:
          function (qrCode) {
            var size =
              qrCode.getModuleCount();

            var penalty = 0;
            var row;
            var col;
            var runColor;
            var runLength;

            /*
             * N1:
             * Five or more consecutive modules
             * in the same colour.
             */
            for (
              row = 0;
              row < size;
              row++
            ) {
              runColor =
                qrCode.isDark(
                  row,
                  0
                );

              runLength = 1;

              for (
                col = 1;
                col < size;
                col++
              ) {
                var rowColor =
                  qrCode.isDark(
                    row,
                    col
                  );

                if (
                  rowColor ===
                  runColor
                ) {
                  runLength++;
                } else {
                  if (
                    runLength >= 5
                  ) {
                    penalty +=
                      3 +
                      (runLength - 5);
                  }

                  runColor =
                    rowColor;

                  runLength = 1;
                }
              }

              if (
                runLength >= 5
              ) {
                penalty +=
                  3 +
                  (runLength - 5);
              }
            }

            for (
              col = 0;
              col < size;
              col++
            ) {
              runColor =
                qrCode.isDark(
                  0,
                  col
                );

              runLength = 1;

              for (
                row = 1;
                row < size;
                row++
              ) {
                var columnColor =
                  qrCode.isDark(
                    row,
                    col
                  );

                if (
                  columnColor ===
                  runColor
                ) {
                  runLength++;
                } else {
                  if (
                    runLength >= 5
                  ) {
                    penalty +=
                      3 +
                      (runLength - 5);
                  }

                  runColor =
                    columnColor;

                  runLength = 1;
                }
              }

              if (
                runLength >= 5
              ) {
                penalty +=
                  3 +
                  (runLength - 5);
              }
            }

            /*
             * N2:
             * Each monochrome 2x2 block.
             */
            for (
              row = 0;
              row < size - 1;
              row++
            ) {
              for (
                col = 0;
                col < size - 1;
                col++
              ) {
                var value =
                  qrCode.isDark(
                    row,
                    col
                  );

                if (
                  value ===
                    qrCode.isDark(
                      row,
                      col + 1
                    ) &&
                  value ===
                    qrCode.isDark(
                      row + 1,
                      col
                    ) &&
                  value ===
                    qrCode.isDark(
                      row + 1,
                      col + 1
                    )
                ) {
                  penalty += 3;
                }
              }
            }

            /*
             * N3:
             * Finder-like 1:1:3:1:1 pattern
             * with four light modules before
             * or after it.
             */
            var patternA = [
              true,
              false,
              true,
              true,
              true,
              false,
              true,
              false,
              false,
              false,
              false
            ];

            var patternB = [
              false,
              false,
              false,
              false,
              true,
              false,
              true,
              true,
              true,
              false,
              true
            ];

            function matchesPattern(
              values,
              offset,
              pattern
            ) {
              for (
                var i = 0;
                i < 11;
                i++
              ) {
                if (
                  values[
                    offset + i
                  ] !== pattern[i]
                ) {
                  return false;
                }
              }

              return true;
            }

            for (
              row = 0;
              row < size;
              row++
            ) {
              var rowValues =
                new Array(size);

              for (
                col = 0;
                col < size;
                col++
              ) {
                rowValues[col] =
                  qrCode.isDark(
                    row,
                    col
                  );
              }

              for (
                col = 0;
                col <= size - 11;
                col++
              ) {
                if (
                  matchesPattern(
                    rowValues,
                    col,
                    patternA
                  ) ||
                  matchesPattern(
                    rowValues,
                    col,
                    patternB
                  )
                ) {
                  penalty += 40;
                }
              }
            }

            for (
              col = 0;
              col < size;
              col++
            ) {
              var columnValues =
                new Array(size);

              for (
                row = 0;
                row < size;
                row++
              ) {
                columnValues[row] =
                  qrCode.isDark(
                    row,
                    col
                  );
              }

              for (
                row = 0;
                row <= size - 11;
                row++
              ) {
                if (
                  matchesPattern(
                    columnValues,
                    row,
                    patternA
                  ) ||
                  matchesPattern(
                    columnValues,
                    row,
                    patternB
                  )
                ) {
                  penalty += 40;
                }
              }
            }

            /*
             * N4:
             * Balance of dark and light modules.
             */
            var darkCount = 0;

            for (
              row = 0;
              row < size;
              row++
            ) {
              for (
                col = 0;
                col < size;
                col++
              ) {
                if (
                  qrCode.isDark(
                    row,
                    col
                  )
                ) {
                  darkCount++;
                }
              }
            }

            var total =
              size * size;

            var percentage =
              darkCount * 100 /
              total;

            var fivePercentSteps =
              Math.floor(
                Math.abs(
                  percentage - 50
                ) /
                5
              );

            penalty +=
              fivePercentSteps * 10;

            return penalty;
          }
      };

      module.exports = QRUtil;
    }
  );

  define(
    "index",
    function (module, exports, require) {
      var QR8bitByte =
        require("QR8bitByte");

      var QRECI =
        require("QRECI");

      var QRMode =
        require("QRMode");

      var QRUtil =
        require("QRUtil");

      var QRPolynomial =
        require("QRPolynomial");

      var QRRSBlock =
        require("QRRSBlock");

      var QRBitBuffer =
        require("QRBitBuffer");

      function QRCode(
        typeNumber,
        errorCorrectLevel
      ) {
        this.typeNumber =
          typeNumber;

        this.errorCorrectLevel =
          errorCorrectLevel;

        this.modules = null;
        this.moduleCount = 0;
        this.dataCache = null;
        this.dataList = [];

        /*
        * ASCIIだけのデータにはECIを付けない。
        * ASCII以外を含む場合は、addData()で
        * UTF-8を示すECI割当番号26を設定する。
        */
        this.eciAssignment = null;
      }

      QRCode.prototype = {
        addData: function (data) {
          var text =
            String(data);

          this.dataList.push(
            new QR8bitByte(text)
          );

          /*
          * 1つでもASCII外の文字を含むセグメントが
          * あれば、UTF-8 ECI 26を付与する。
          */
          if (
            !QR8bitByte.isAscii(text)
          ) {
            this.eciAssignment = 26;
          }

          this.dataCache = null;
        },

        isDark: function (
          row,
          col
        ) {
          if (
            row < 0 ||
            row >= this.moduleCount ||
            col < 0 ||
            col >= this.moduleCount
          ) {
            throw new Error(
              row + "," + col
            );
          }

          return this.modules[
            row
          ][col];
        },

        getModuleCount:
          function () {
            return this.moduleCount;
          },

        getTypeNumber:
          function () {
            return this.typeNumber;
          },

        getDataByteLength:
          function () {
            var length = 0;

            for (
              var i = 0;
              i <
              this.dataList.length;
              i++
            ) {
              length +=
                this.dataList[
                  i
                ].getLength();
            }

            return length;
          },

        getEciAssignment:
          function () {
            return this.eciAssignment;
          },

        make: function () {
          if (
            this.typeNumber < 1
          ) {
            var selected = 0;

            for (
              var candidate = 1;
              candidate <= 40;
              candidate++
            ) {
              if (
                QRCode.canFitData(
                  candidate,
                  this.errorCorrectLevel,
                  this.dataList,
                  this.eciAssignment
                )
              ) {
                selected =
                  candidate;

                break;
              }
            }

            if (!selected) {
              throw new Error(
                "code length overflow"
              );
            }

            this.typeNumber =
              selected;
          }

          /*
           * Validate explicitly selected
           * versions as well.
           */
          if (
            !QRCode.canFitData(
              this.typeNumber,
              this.errorCorrectLevel,
              this.dataList,
              this.eciAssignment
            )
          ) {
            throw new Error(
              "code length overflow"
            );
          }

          this.dataCache = null;

          this.makeImpl(
            false,
            this.getBestMaskPattern()
          );
        },

        makeImpl: function (
          test,
          maskPattern
        ) {
          this.moduleCount =
            this.typeNumber * 4 +
            17;

          this.modules =
            new Array(
              this.moduleCount
            );

          for (
            var row = 0;
            row < this.moduleCount;
            row++
          ) {
            this.modules[row] =
              new Array(
                this.moduleCount
              );

            for (
              var col = 0;
              col < this.moduleCount;
              col++
            ) {
              this.modules[
                row
              ][col] = null;
            }
          }

          this.setupPositionProbePattern(
            0,
            0
          );

          this.setupPositionProbePattern(
            this.moduleCount - 7,
            0
          );

          this.setupPositionProbePattern(
            0,
            this.moduleCount - 7
          );

          this.setupPositionAdjustPattern();
          this.setupTimingPattern();

          this.setupTypeInfo(
            test,
            maskPattern
          );

          if (
            this.typeNumber >= 7
          ) {
            this.setupTypeNumber(
              test
            );
          }

          if (
            this.dataCache === null
          ) {
            this.dataCache =
              QRCode.createData(
                this.typeNumber,
                this.errorCorrectLevel,
                this.dataList,
                this.eciAssignment
              );
          }

          this.mapData(
            this.dataCache,
            maskPattern
          );
        },

        setupPositionProbePattern:
          function (
            row,
            col
          ) {
            for (
              var r = -1;
              r <= 7;
              r++
            ) {
              if (
                row + r < 0 ||
                row + r >=
                  this.moduleCount
              ) {
                continue;
              }

              for (
                var c = -1;
                c <= 7;
                c++
              ) {
                if (
                  col + c < 0 ||
                  col + c >=
                    this.moduleCount
                ) {
                  continue;
                }

                if (
                  (
                    r >= 0 &&
                    r <= 6 &&
                    (
                      c === 0 ||
                      c === 6
                    )
                  ) ||
                  (
                    c >= 0 &&
                    c <= 6 &&
                    (
                      r === 0 ||
                      r === 6
                    )
                  ) ||
                  (
                    r >= 2 &&
                    r <= 4 &&
                    c >= 2 &&
                    c <= 4
                  )
                ) {
                  this.modules[
                    row + r
                  ][col + c] = true;
                } else {
                  this.modules[
                    row + r
                  ][col + c] = false;
                }
              }
            }
          },

        getBestMaskPattern:
          function () {
            var minimum = 0;
            var pattern = 0;

            for (
              var i = 0;
              i < 8;
              i++
            ) {
              this.makeImpl(
                true,
                i
              );

              var lostPoint =
                QRUtil.getLostPoint(
                  this
                );

              if (
                i === 0 ||
                lostPoint < minimum
              ) {
                minimum =
                  lostPoint;

                pattern = i;
              }
            }

            return pattern;
          },

        setupTimingPattern:
          function () {
            var r;
            var c;

            for (
              r = 8;
              r <
              this.moduleCount - 8;
              r++
            ) {
              if (
                this.modules[
                  r
                ][6] !== null
              ) {
                continue;
              }

              this.modules[
                r
              ][6] =
                r % 2 === 0;
            }

            for (
              c = 8;
              c <
              this.moduleCount - 8;
              c++
            ) {
              if (
                this.modules[
                  6
                ][c] !== null
              ) {
                continue;
              }

              this.modules[
                6
              ][c] =
                c % 2 === 0;
            }
          },

        setupPositionAdjustPattern:
          function () {
            var pos =
              QRUtil.getPatternPosition(
                this.typeNumber
              );

            for (
              var i = 0;
              i < pos.length;
              i++
            ) {
              for (
                var j = 0;
                j < pos.length;
                j++
              ) {
                var row = pos[i];
                var col = pos[j];

                if (
                  this.modules[
                    row
                  ][col] !== null
                ) {
                  continue;
                }

                for (
                  var r = -2;
                  r <= 2;
                  r++
                ) {
                  for (
                    var c = -2;
                    c <= 2;
                    c++
                  ) {
                    this.modules[
                      row + r
                    ][col + c] =
                      Math.abs(r) === 2 ||
                      Math.abs(c) === 2 ||
                      (
                        r === 0 &&
                        c === 0
                      );
                  }
                }
              }
            }
          },

        setupTypeNumber:
          function (test) {
            var bits =
              QRUtil.getBCHTypeNumber(
                this.typeNumber
              );

            var mod;
            var i;

            for (
              i = 0;
              i < 18;
              i++
            ) {
              mod =
                !test &&
                (
                  (
                    bits >> i
                  ) &
                  1
                ) === 1;

              this.modules[
                Math.floor(i / 3)
              ][
                i % 3 +
                this.moduleCount -
                11
              ] = mod;
            }

            for (
              i = 0;
              i < 18;
              i++
            ) {
              mod =
                !test &&
                (
                  (
                    bits >> i
                  ) &
                  1
                ) === 1;

              this.modules[
                i % 3 +
                this.moduleCount -
                11
              ][
                Math.floor(i / 3)
              ] = mod;
            }
          },

        setupTypeInfo:
          function (
            test,
            maskPattern
          ) {
            var data =
              (
                this
                  .errorCorrectLevel <<
                3
              ) |
              maskPattern;

            var bits =
              QRUtil.getBCHTypeInfo(
                data
              );

            var mod;
            var i;

            for (
              i = 0;
              i < 15;
              i++
            ) {
              mod =
                !test &&
                (
                  (
                    bits >> i
                  ) &
                  1
                ) === 1;

              if (i < 6) {
                this.modules[
                  i
                ][8] = mod;
              } else if (
                i < 8
              ) {
                this.modules[
                  i + 1
                ][8] = mod;
              } else {
                this.modules[
                  this.moduleCount -
                  15 +
                  i
                ][8] = mod;
              }
            }

            for (
              i = 0;
              i < 15;
              i++
            ) {
              mod =
                !test &&
                (
                  (
                    bits >> i
                  ) &
                  1
                ) === 1;

              if (i < 8) {
                this.modules[
                  8
                ][
                  this.moduleCount -
                  i -
                  1
                ] = mod;
              } else if (
                i < 9
              ) {
                this.modules[
                  8
                ][15 - i] = mod;
              } else {
                this.modules[
                  8
                ][15 - i - 1] =
                  mod;
              }
            }

            this.modules[
              this.moduleCount - 8
            ][8] = !test;
          },

        mapData: function (
          data,
          maskPattern
        ) {
          var inc = -1;
          var row =
            this.moduleCount - 1;

          var bitIndex = 7;
          var byteIndex = 0;

          for (
            var col =
              this.moduleCount - 1;
            col > 0;
            col -= 2
          ) {
            if (col === 6) {
              col--;
            }

            while (true) {
              for (
                var c = 0;
                c < 2;
                c++
              ) {
                if (
                  this.modules[
                    row
                  ][col - c] !== null
                ) {
                  continue;
                }

                var dark = false;

                if (
                  byteIndex <
                  data.length
                ) {
                  dark =
                    (
                      (
                        data[
                          byteIndex
                        ] >>>
                        bitIndex
                      ) &
                      1
                    ) === 1;
                }

                if (
                  QRUtil.getMask(
                    maskPattern,
                    row,
                    col - c
                  )
                ) {
                  dark = !dark;
                }

                this.modules[
                  row
                ][col - c] = dark;

                bitIndex--;

                if (
                  bitIndex === -1
                ) {
                  byteIndex++;
                  bitIndex = 7;
                }
              }

              row += inc;

              if (
                row < 0 ||
                row >=
                  this.moduleCount
              ) {
                row -= inc;
                inc = -inc;
                break;
              }
            }
          }
        }
      };

      QRCode.PAD0 = 0xEC;
      QRCode.PAD1 = 0x11;

      QRCode.putSegments =
        function (
          buffer,
          typeNumber,
          dataList,
          eciAssignment
        ) {
          if (
            dataList.length > 0 &&
            eciAssignment !==
              null &&
            eciAssignment !==
              undefined
          ) {
            var eci =
              new QRECI(
                eciAssignment
              );

            buffer.put(
              QRMode.MODE_ECI,
              4
            );

            eci.write(buffer);
          }

          for (
            var i = 0;
            i < dataList.length;
            i++
          ) {
            var data =
              dataList[i];

            buffer.put(
              data.mode,
              4
            );

            buffer.put(
              data.getLength(),
              QRUtil.getLengthInBits(
                data.mode,
                typeNumber
              )
            );

            data.write(buffer);
          }
        };

      QRCode.getTotalDataCount =
        function (
          typeNumber,
          errorCorrectLevel
        ) {
          var rsBlocks =
            QRRSBlock.getRSBlocks(
              typeNumber,
              errorCorrectLevel
            );

          var total = 0;

          for (
            var i = 0;
            i < rsBlocks.length;
            i++
          ) {
            total +=
              rsBlocks[
                i
              ].dataCount;
          }

          return total;
        };

	QRCode.validateSegmentLengths =
		function (
			typeNumber,
			dataList
		) {
			for (
			var i = 0;
			i < dataList.length;
			i++
			) {
			var data =
				dataList[i];

			var lengthBits =
				QRUtil.getLengthInBits(
				data.mode,
				typeNumber
				);

			var maxLength =
				Math.pow(
				2,
				lengthBits
				) - 1;

			if (
				data.getLength() >
				maxLength
			) {
				return false;
			}
			}

			return true;
		};

	QRCode.canFitData =
		function (
			typeNumber,
			errorCorrectLevel,
			dataList,
			eciAssignment
		) {
			try {
			if (
				!Number.isInteger(typeNumber) ||
				typeNumber < 1 ||
				typeNumber > 40
			) {
				return false;
			}

			if (
				!QRCode.validateSegmentLengths(
				typeNumber,
				dataList
				)
			) {
				return false;
			}

			var capacityBits =
				QRCode.getTotalDataCount(
				typeNumber,
				errorCorrectLevel
				) * 8;

			var buffer =
				new QRBitBuffer();

			QRCode.putSegments(
				buffer,
				typeNumber,
				dataList,
				eciAssignment
			);

			return (
				buffer.getLengthInBits() <=
				capacityBits
			);
			} catch (error) {
			return false;
			}
		};

	QRCode.createData =
		function (
			typeNumber,
			errorCorrectLevel,
			dataList,
			eciAssignment
		) {
			if (
			!QRCode.validateSegmentLengths(
				typeNumber,
				dataList
			)
			) {
			throw new Error(
				"code length overflow"
			);
			}

			var rsBlocks =
			QRRSBlock.getRSBlocks(
				typeNumber,
				errorCorrectLevel
			);

			var buffer =
			new QRBitBuffer();

			QRCode.putSegments(
			buffer,
			typeNumber,
			dataList,
			eciAssignment
			);

			var totalDataCount = 0;

			for (
			var i = 0;
			i < rsBlocks.length;
			i++
			) {
			totalDataCount +=
				rsBlocks[i].dataCount;
			}

			var capacityBits =
			totalDataCount * 8;

			if (
			buffer.getLengthInBits() >
			capacityBits
			) {
			throw new Error(
				"code length overflow. (" +
				buffer.getLengthInBits() +
				">" +
				capacityBits +
				")"
			);
			}

			var remainingBits =
			capacityBits -
			buffer.getLengthInBits();

			var terminatorLength =
			Math.min(
				4,
				remainingBits
			);

			if (
			terminatorLength > 0
			) {
			buffer.put(
				0,
				terminatorLength
			);
			}

			while (
			buffer.getLengthInBits() %
				8 !==
			0 &&
			buffer.getLengthInBits() <
				capacityBits
			) {
			buffer.putBit(false);
			}

			var usePadZero = true;

			while (
			buffer.getLengthInBits() <
			capacityBits
			) {
			buffer.put(
				usePadZero
				? QRCode.PAD0
				: QRCode.PAD1,
				8
			);

			usePadZero =
				!usePadZero;
			}

			if (
			buffer.getLengthInBits() !==
			capacityBits
			) {
			throw new Error(
				"code length overflow"
			);
			}

			return QRCode.createBytes(
			buffer,
			rsBlocks
			);
		};

      QRCode.createBytes =
        function (
          buffer,
          rsBlocks
        ) {
          var offset = 0;
          var maxDcCount = 0;
          var maxEcCount = 0;

          var dcdata =
            new Array(
              rsBlocks.length
            );

          var ecdata =
            new Array(
              rsBlocks.length
            );

          var r;
          var i;

          for (
            r = 0;
            r < rsBlocks.length;
            r++
          ) {
            var dcCount =
              rsBlocks[
                r
              ].dataCount;

            var ecCount =
              rsBlocks[
                r
              ].totalCount -
              dcCount;

            maxDcCount =
              Math.max(
                maxDcCount,
                dcCount
              );

            maxEcCount =
              Math.max(
                maxEcCount,
                ecCount
              );

            dcdata[r] =
              new Array(dcCount);

            for (
              i = 0;
              i < dcCount;
              i++
            ) {
              dcdata[r][i] =
                0xFF &
                buffer.buffer[
                  i + offset
                ];
            }

            offset += dcCount;

            var rsPoly =
              QRUtil
                .getErrorCorrectPolynomial(
                  ecCount
                );

            var rawPoly =
              new QRPolynomial(
                dcdata[r],
                rsPoly.getLength() -
                  1
              );

            var modPoly =
              rawPoly.mod(rsPoly);

            ecdata[r] =
              new Array(
                rsPoly.getLength() -
                1
              );

            for (
              i = 0;
              i < ecdata[r].length;
              i++
            ) {
              var modIndex =
                i +
                modPoly.getLength() -
                ecdata[r].length;

              ecdata[r][i] =
                modIndex >= 0
                  ? modPoly.get(
                      modIndex
                    )
                  : 0;
            }
          }

          var totalCodeCount = 0;

          for (
            r = 0;
            r < rsBlocks.length;
            r++
          ) {
            totalCodeCount +=
              rsBlocks[
                r
              ].totalCount;
          }

          var data =
            new Array(
              totalCodeCount
            );

          var index = 0;

          for (
            i = 0;
            i < maxDcCount;
            i++
          ) {
            for (
              r = 0;
              r < rsBlocks.length;
              r++
            ) {
              if (
                i <
                dcdata[r].length
              ) {
                data[index++] =
                  dcdata[r][i];
              }
            }
          }

          for (
            i = 0;
            i < maxEcCount;
            i++
          ) {
            for (
              r = 0;
              r < rsBlocks.length;
              r++
            ) {
              if (
                i <
                ecdata[r].length
              ) {
                data[index++] =
                  ecdata[r][i];
              }
            }
          }

          return data;
        };

      QRCode.toUtf8Bytes =
        QR8bitByte.toUtf8Bytes;

      module.exports = QRCode;
    }
  );

  global.LocalQRCode = {
    QRCode:
      require("index"),

    CorrectLevel:
      require(
        "QRErrorCorrectLevel"
      ),

    toUtf8Bytes:
      require(
        "QR8bitByte"
      ).toUtf8Bytes,

    isAscii:
      require(
        "QR8bitByte"
      ).isAscii,

    validateRsBlockTable:
      require(
        "QRRSBlock"
      ).validateTable
  };
})(
  typeof window !== "undefined"
    ? window
    : globalThis
);
